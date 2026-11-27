import type { ModelEvidence, RoutingPolicy, ScoreComponents } from '@devbrain/contracts';

/** Wilson score 95% lower bound: small samples cannot produce confident high scores. */
export const wilsonLower = (successes: number, samples: number, z = 1.96): number => {
  if (samples <= 0) return 0;
  const p = successes / samples;
  const z2 = z * z;
  const centre = p + z2 / (2 * samples);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * samples)) / samples);
  return Math.max(0, (centre - margin) / (1 + z2 / samples));
};

export const confidenceFor = (samples: number): ModelEvidence['confidence'] =>
  samples < 5 ? 'insufficient' : samples < 20 ? 'low' : samples < 50 ? 'moderate' : 'high';

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

export interface Observations {
  successes: number;
  samples: number;
  latenciesMs: number[];
  suiteVersions?: string[];
}

/** Benchmark evidence wins over production history; neither → `none`. */
export const buildEvidence = (
  modelId: string,
  benchmark: Observations | null,
  history: Observations | null,
): ModelEvidence => {
  const pick =
    benchmark && benchmark.samples > 0
      ? { source: 'benchmark' as const, o: benchmark }
      : history && history.samples > 0
        ? { source: 'history' as const, o: history }
        : null;
  if (!pick)
    return {
      modelId,
      samples: 0,
      successes: 0,
      wilsonLower: 0,
      confidence: 'insufficient',
      medianLatencyMs: null,
      source: 'none',
      suiteVersions: [],
    };
  return {
    modelId,
    samples: pick.o.samples,
    successes: pick.o.successes,
    wilsonLower: wilsonLower(pick.o.successes, pick.o.samples),
    confidence: confidenceFor(pick.o.samples),
    medianLatencyMs: median(pick.o.latenciesMs),
    source: pick.source,
    suiteVersions: (pick.o.suiteVersions ?? []).slice(0, 20),
  };
};

export type Preset = NonNullable<RoutingPolicy['preset']>;
type Weights = Record<Exclude<keyof ScoreComponents, 'exploration'>, number>;

const PRESET_WEIGHTS: Record<Exclude<Preset, 'custom'>, Weights> = {
  'free-only': { specialty: 0.15, quality: 0.3, reliability: 0.2, latency: 0.1, cost: 0, quota: 0.15, continuity: 0.1 },
  'local-only': { specialty: 0.15, quality: 0.35, reliability: 0.2, latency: 0.15, cost: 0, quota: 0.05, continuity: 0.1 },
  economy: { specialty: 0.1, quality: 0.15, reliability: 0.15, latency: 0.05, cost: 0.4, quota: 0.1, continuity: 0.05 },
  balanced: { specialty: 0.15, quality: 0.25, reliability: 0.15, latency: 0.1, cost: 0.15, quota: 0.1, continuity: 0.1 },
  quality: { specialty: 0.15, quality: 0.45, reliability: 0.2, latency: 0.05, cost: 0.02, quota: 0.05, continuity: 0.08 },
};

export const weightsFor = (policy: Pick<RoutingPolicy, 'preset' | 'weights'>): Weights => {
  const preset = policy.preset ?? 'balanced';
  if (preset !== 'custom') return PRESET_WEIGHTS[preset];
  const out = { ...PRESET_WEIGHTS.balanced };
  for (const [key, value] of Object.entries(policy.weights ?? {}))
    if (typeof value === 'number') out[key as keyof Weights] = value;
  return out;
};

export interface ScoreInputs {
  specialty: number;
  /** Quality tier rank 0..3 (evidence-backed when available). */
  tierRank: number;
  evidence: ModelEvidence;
  worstCaseMicros: number | null;
  remainingFraction: number;
  /** Same model as the session's last successful route (cache reuse, no handoff cost). */
  continuity: boolean;
  explore: boolean;
}

/**
 * ModelScoringService — Stage 2 only. Runs on candidates that already passed every hard
 * constraint; the score orders them and can never re-admit an excluded route. Deterministic:
 * same inputs → same order (exploration is a fixed, small bonus for under-tested routes that
 * are already eligible, free and within budget — never randomised spending).
 */
export class ModelScoringService {
  components(i: ScoreInputs): ScoreComponents {
    const measured = i.evidence.confidence !== 'insufficient';
    return {
      specialty: i.specialty,
      quality: measured ? (i.tierRank / 3) * 0.5 + i.evidence.wilsonLower * 0.5 : i.tierRank / 3,
      reliability: measured ? i.evidence.wilsonLower : 0.5,
      latency:
        i.evidence.medianLatencyMs === null ? 0.5 : 1 / (1 + i.evidence.medianLatencyMs / 5000),
      // 10_000 micros = one cent: a worst case of 1¢ halves the cost score.
      cost: i.worstCaseMicros === null ? 0 : 1 / (1 + i.worstCaseMicros / 10_000),
      quota: Math.max(0, Math.min(1, i.remainingFraction)),
      continuity: i.continuity ? 1 : 0,
      exploration: i.explore && !measured ? 0.05 : 0,
    };
  }

  score(c: ScoreComponents, w: Weights): number {
    const total =
      w.specialty * c.specialty +
      w.quality * c.quality +
      w.reliability * c.reliability +
      w.latency * c.latency +
      w.cost * c.cost +
      w.quota * c.quota +
      w.continuity * c.continuity;
    const norm = Object.values(w).reduce((a, b) => a + b, 0) || 1;
    return Math.round((total / norm + c.exploration) * 10_000) / 10_000;
  }
}
