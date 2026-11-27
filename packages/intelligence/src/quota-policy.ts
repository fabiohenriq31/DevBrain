import type {
  ExclusionCode,
  InferenceRequest,
  ModelDefinition,
  ModelRoute,
  ProviderConnection,
  ProviderEndpoint,
  QuotaDefinition,
  QuotaForecast,
  TaskPriority,
} from '@devbrain/contracts';
import type { LedgerPort } from './ledger-port.js';

export interface QuotaCandidate {
  route: ModelRoute;
  model: ModelDefinition;
  connection: ProviderConnection;
  endpoint: ProviderEndpoint;
}

/**
 * Fraction of every provider window that only higher priorities may consume. Critical work
 * may use everything; background work stops while 60% remains, so routine jobs cannot
 * exhaust a shared quota that critical work will need later in the window.
 */
export const PRIORITY_RESERVE: Record<TaskPriority, number> = {
  critical: 0,
  high: 0.1,
  normal: 0.2,
  low: 0.4,
  background: 0.6,
};

/** Pacing headroom over linear consumption for low-priority work (fraction of the limit). */
const PACING_HEADROOM = 0.25;

export interface QuotaVerdict {
  ok: boolean;
  code?: ExclusionCode;
  message: string;
  /** Smallest remaining fraction across matching limited quotas (1 when none apply). */
  remainingFraction: number;
  demands: { quotaId: string; amount: number }[];
}

/**
 * QuotaPolicyEngine — policy over the gateway QuotaLedger (no second quota store).
 * - Shared quotas: a definition scoped to a provider, endpoint or credential applies to every
 *   route that uses it. Several keys of the same provider are NOT independent token sources:
 *   only quotas explicitly defined per credential are tracked separately, and a rate-limit
 *   signal cools down the whole provider (see `sharedCooldownRoutes`).
 * - Uncertain consumption (no usage reported, crashes) is counted at the full reserved amount.
 * - Priority reserves and pacing stop low-priority work from exhausting a window early.
 * - Estimates are labelled; only verified definitions produce `official` reset times.
 */
export class QuotaPolicyEngine {
  constructor(
    private readonly ledger: LedgerPort,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Provider-origin quotas that bind this candidate. */
  definitionsFor(candidate: QuotaCandidate): QuotaDefinition[] {
    const scopes = new Set(
      [
        candidate.model.id,
        candidate.connection.id,
        candidate.connection.providerId,
        candidate.endpoint.id,
        candidate.connection.credentialId,
      ].filter((s): s is string => !!s),
    );
    return this.ledger
      .definitions()
      .filter((d) => d.origin !== 'devbrain' && scopes.has(d.scopeId));
  }

  demand(def: QuotaDefinition, inputTokens: number, outputTokens: number): number {
    switch (def.unit) {
      case 'requests':
        return 1;
      case 'input-tokens':
        return inputTokens;
      case 'output-tokens':
      case 'reasoning-tokens':
        return outputTokens;
      case 'total-tokens':
        return inputTokens + outputTokens;
      default:
        // cached-tokens/provider-unit/currency: not derivable before the call.
        return 0;
    }
  }

  evaluate(
    candidate: QuotaCandidate,
    request: Pick<InferenceRequest, 'maxOutputTokens'>,
    inputTokens: number,
    priority: TaskPriority,
  ): QuotaVerdict {
    const outputTokens = request.maxOutputTokens ?? candidate.model.capabilities.outputTokens ?? 0;
    const demands: QuotaVerdict['demands'] = [];
    let remainingFraction = 1;
    for (const def of this.definitionsFor(candidate)) {
      const amount = this.demand(def, inputTokens, outputTokens);
      demands.push({ quotaId: def.id, amount });
      const w = this.ledger.windowState(def.id);
      if (!w || def.limit === null || w.remaining === null) continue;
      const fraction = def.limit > 0 ? w.remaining / def.limit : 0;
      remainingFraction = Math.min(remainingFraction, fraction);
      if (amount > w.remaining)
        return {
          ok: false,
          code: 'quota-exhausted',
          message: `${def.id}: ${w.remaining} ${def.unit} left, needs ${amount} (resets ${w.resetAt})`,
          remainingFraction,
          demands,
        };
      const after = def.limit > 0 ? (w.remaining - amount) / def.limit : 0;
      const reserve = PRIORITY_RESERVE[priority];
      if (after < reserve)
        return {
          ok: false,
          code: 'quota-reserved-for-priority',
          message: `${def.id}: last ${Math.round(reserve * 100)}% reserved for higher-priority work`,
          remainingFraction,
          demands,
        };
      if (priority === 'low' || priority === 'background') {
        const period = (def.periodSeconds ?? 86_400) * 1000;
        const elapsed = (this.clock() - Date.parse(w.windowStart)) / period;
        const allowed = def.limit * Math.min(1, elapsed + PACING_HEADROOM);
        if (w.used + w.reserved + amount > allowed)
          return {
            ok: false,
            code: 'quota-reserved-for-priority',
            message: `${def.id}: pacing — ${priority} work is ahead of the window schedule`,
            remainingFraction,
            demands,
          };
      }
    }
    return { ok: true, message: 'within quotas', remainingFraction, demands };
  }

  forecast(quotaId: string): QuotaForecast {
    const w = this.ledger.windowState(quotaId);
    if (!w)
      return {
        quotaId,
        remaining: null,
        resetAt: null,
        resetBasis: 'unknown',
        projectedExhaustionAt: null,
        projectionBasis: 'unknown',
      };
    const official = !!(w.definition.verifiedAt && w.definition.sourceUrl);
    const now = this.clock();
    const elapsed = now - Date.parse(w.windowStart);
    const consumed = w.used + w.reserved;
    let projected: string | null = null;
    if (w.remaining !== null && consumed > 0 && elapsed > 0) {
      const eta = now + (w.remaining / consumed) * elapsed;
      if (eta < Date.parse(w.resetAt)) projected = new Date(eta).toISOString();
    }
    return {
      quotaId,
      remaining: w.remaining,
      resetAt: w.resetAt,
      resetBasis: official ? 'official' : 'estimate',
      projectedExhaustionAt: projected,
      projectionBasis: projected ? 'estimate' : 'unknown',
    };
  }

  /**
   * Routes to cool down after a rate-limit/quota signal: every route of the same provider.
   * Separate keys of one provider usually share account/organization limits, so treating a key
   * as a fresh source would be an attempt to bypass provider restrictions.
   */
  sharedCooldownRoutes(failed: QuotaCandidate, all: readonly QuotaCandidate[]): string[] {
    return all
      .filter((c) => c.connection.providerId === failed.connection.providerId)
      .map((c) => c.route.id);
  }
}
