import { z } from 'zod';
import { ProjectIdSchema, SessionIdSchema, TimestampSchema } from '../common.js';
import { AiResourceIdSchema as Id, AiResourceSafeUrlSchema as SafeUrl } from './ai-resource.js';
import { QualityTierSchema, TaskKindSchema } from './task.js';

/**
 * @since 0.7.0 — Phase 02 intelligence: privacy, budget, explainable routing, cost states,
 * handoff and benchmarks. Money is ALWAYS integer micro-units (1 unit = 1_000_000 micros) of an
 * ISO currency; floats are for display only.
 */
const Micros = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Currency = z.string().length(3);

// ---------------------------------------------------------------------------- privacy
export const ProjectPrivacyClassSchema = z.enum([
  'public',
  'personal-private',
  'commercial-confidential',
  'restricted',
]);
export type ProjectPrivacyClass = z.infer<typeof ProjectPrivacyClassSchema>;

const Fact = <T extends [string, ...string[]]>(values: T) => z.enum([...values, 'unknown']);
/**
 * What is VERIFIABLY known about a provider's data handling. Every field defaults to
 * `unknown`, which policies treat conservatively. Only the user (or a verified catalog entry
 * with `sourceUrl`) can set facts; an AI reading documentation is not verification.
 */
export const ProviderPrivacyProfileSchema = z.object({
  providerId: Id,
  retention: Fact(['none', 'limited', 'indefinite']).default('unknown'),
  retentionDays: z.number().int().nonnegative().nullable().default(null),
  trainingOnInputs: Fact(['no', 'opt-out', 'yes']).default('unknown'),
  commercialUse: Fact(['allowed', 'restricted']).default('unknown'),
  processingRegion: z.string().max(100).nullable().default(null),
  intermediaries: Fact(['none', 'disclosed']).default('unknown'),
  contract: Fact(['dpa', 'terms-only']).default('unknown'),
  deletion: Fact(['automatic', 'on-request', 'none']).default('unknown'),
  security: Fact(['certified', 'documented']).default('unknown'),
  sourceUrl: SafeUrl.nullable().default(null),
  verifiedAt: TimestampSchema.nullable().default(null),
  verifiedBy: z.enum(['user', 'catalog']).nullable().default(null),
});
export type ProviderPrivacyProfile = z.infer<typeof ProviderPrivacyProfileSchema>;

// ---------------------------------------------------------------------------- project policy
export const ProjectAiPolicySchema = z.object({
  projectId: ProjectIdSchema,
  privacyClass: ProjectPrivacyClassSchema.default('personal-private'),
  /** Explicitly approved providers (required for commercial-confidential). */
  approvedProviderIds: z.array(Id).max(200).default([]),
  /** DevBrain-enforced ceilings (micros of `currency`); null = no ceiling at this scope. */
  budget: z
    .object({
      currency: Currency.default('USD'),
      maxPerDayMicros: Micros.nullable().default(null),
      maxPerSessionMicros: Micros.nullable().default(null),
      maxPerInferenceMicros: Micros.nullable().default(null),
      /** Paid routes need this explicit authorization. */
      allowPaid: z.boolean().default(false),
      /**
       * Strict (default): a route whose worst-case cost cannot be bounded is blocked whenever
       * any ceiling applies. True = informed consent to run without a cost guarantee.
       */
      allowUnboundedCost: z.boolean().default(false),
    })
    .prefault({}),
  updatedAt: TimestampSchema,
});
export type ProjectAiPolicy = z.infer<typeof ProjectAiPolicySchema>;

// ---------------------------------------------------------------------------- routing
export const ExclusionCodeSchema = z.enum([
  'not-authorized',
  'missing-capability',
  'context-too-small',
  'quota-exhausted',
  'quota-reserved-for-priority',
  'budget',
  'cost-unbounded',
  'paid-not-authorized',
  'privacy',
  'unavailable',
  'cooldown',
  'protocol',
  'security',
  'quality-below-minimum',
  'model-pinned',
]);
export type ExclusionCode = z.infer<typeof ExclusionCodeSchema>;

export const ScoreComponentsSchema = z.object({
  specialty: z.number(),
  quality: z.number(),
  reliability: z.number(),
  latency: z.number(),
  cost: z.number(),
  quota: z.number(),
  continuity: z.number(),
  exploration: z.number(),
});
export type ScoreComponents = z.infer<typeof ScoreComponentsSchema>;

export const CostStateSchema = z.enum(['free', 'estimated', 'reconciled', 'reported', 'unknown']);
export type CostState = z.infer<typeof CostStateSchema>;

export const ExplainedRoutingDecisionSchema = z.object({
  requestId: Id,
  policyId: Id,
  preset: z.enum(['free-only', 'local-only', 'economy', 'balanced', 'quality', 'custom']),
  taskKind: TaskKindSchema,
  minQualityTier: QualityTierSchema,
  estimate: z.object({
    inputTokens: z.number().int().nonnegative(),
    /** `exact`: model tokenizer; `conservative`: upper-bound heuristic. */
    tokenizer: z.enum(['exact', 'conservative']),
  }),
  ranked: z.array(
    z.object({
      routeId: Id,
      modelId: Id,
      providerId: Id,
      score: z.number(),
      components: ScoreComponentsSchema,
      qualityTier: QualityTierSchema,
      evidence: z.enum(['benchmark', 'history', 'metadata']),
      worstCaseCostMicros: Micros.nullable(),
      costState: CostStateSchema,
      notes: z.array(z.string()).max(20),
    }),
  ),
  excluded: z.array(
    z.object({
      routeId: Id,
      reasons: z
        .array(z.object({ code: ExclusionCodeSchema, message: z.string().max(500) }))
        .min(1),
    }),
  ),
  decidedAt: TimestampSchema,
});
export type ExplainedRoutingDecision = z.infer<typeof ExplainedRoutingDecisionSchema>;

// ---------------------------------------------------------------------------- cost
export const CostRecordSchema = z.object({
  requestId: Id,
  routeId: Id,
  currency: Currency,
  /** Worst case reserved before dispatch (null = could not be bounded). */
  estimatedMicros: Micros.nullable(),
  /** Measured tokens × verified price. */
  reconciledMicros: Micros.nullable(),
  /** Cost the provider itself reported. */
  reportedMicros: Micros.nullable(),
  state: CostStateSchema,
  recordedAt: TimestampSchema,
});
export type CostRecord = z.infer<typeof CostRecordSchema>;

export const BudgetStatusSchema = z.object({
  scope: z.enum(['global', 'project', 'session']),
  scopeId: z.string(),
  currency: Currency,
  limitMicros: Micros.nullable(),
  committedMicros: Micros,
  reservedMicros: Micros,
  /** Executions whose cost could not be determined (spend is then a lower bound). */
  unknownCostRequests: z.number().int().nonnegative(),
  /** DevBrain enforces this ceiling before dispatch; provider limits are tracked separately. */
  enforcedBy: z.literal('devbrain'),
});
export type BudgetStatus = z.infer<typeof BudgetStatusSchema>;

export const QuotaForecastSchema = z.object({
  quotaId: Id,
  remaining: z.number().nonnegative().nullable(),
  resetAt: TimestampSchema.nullable(),
  /** `official`: from provider data; `estimate`: DevBrain extrapolation. */
  resetBasis: z.enum(['official', 'estimate', 'unknown']),
  projectedExhaustionAt: TimestampSchema.nullable(),
  projectionBasis: z.enum(['estimate', 'unknown']),
});
export type QuotaForecast = z.infer<typeof QuotaForecastSchema>;

// ---------------------------------------------------------------------------- handoff
export const SideEffectSchema = z.object({
  id: z.string().min(1).max(200),
  tool: z.string().min(1).max(200),
  description: z.string().max(2000),
  /** `unknown`: dispatched but not confirmed; must be reconciled before any retry. */
  status: z.enum(['planned', 'executed', 'confirmed', 'failed', 'unknown']),
  idempotencyKey: z.string().max(200).nullable(),
});
export type SideEffect = z.infer<typeof SideEffectSchema>;

export const HandoffKindSchema = z.enum([
  'fallback-before-generation',
  'fallback-during-inference',
  'regeneration-after-failure',
  'session-continuation',
  'agent-transfer',
]);
export type HandoffKind = z.infer<typeof HandoffKindSchema>;

export const HandoffPacketSchema = z.object({
  version: z.literal(1),
  kind: HandoffKindSchema,
  taskId: z.string().min(1).max(200),
  objective: z.string().max(20_000),
  requirements: z.array(z.string().max(2000)).max(100),
  constraints: z.array(z.string().max(2000)).max(100),
  projectId: ProjectIdSchema.nullable(),
  workspaceId: z.string().nullable(),
  sessionId: SessionIdSchema.nullable(),
  branch: z.string().max(300).nullable(),
  baseCommit: z.string().max(64).nullable(),
  filesTouched: z.array(z.string().max(1000)).max(5000),
  decisions: z.array(z.string().max(2000)).max(200),
  toolRuns: z
    .array(
      z.object({
        tool: z.string().max(200),
        summary: z.string().max(4000),
        ok: z.boolean().nullable(),
      }),
    )
    .max(200),
  tests: z
    .array(z.object({ name: z.string().max(500), status: z.enum(['passed', 'failed', 'unknown']) }))
    .max(500),
  errors: z.array(z.string().max(4000)).max(100),
  pending: z.array(z.string().max(2000)).max(200),
  nextAction: z.string().max(4000).nullable(),
  completion: z.enum(['not-started', 'in-progress', 'blocked', 'done', 'unknown']),
  sideEffects: z.array(SideEffectSchema).max(500),
  /** Side effects that must be reconciled by a human or a read-only check before resuming. */
  reconciliationRequired: z.array(z.string()).max(500),
  createdAt: TimestampSchema,
});
export type HandoffPacket = z.infer<typeof HandoffPacketSchema>;

// ---------------------------------------------------------------------------- context
export const ContextOptimizationReportSchema = z.object({
  tokenizer: z.enum(['exact', 'conservative']),
  originalTokens: z.number().int().nonnegative(),
  optimizedTokens: z.number().int().nonnegative(),
  budgetTokens: z.number().int().positive(),
  preservedCritical: z.number().int().nonnegative(),
  actions: z
    .array(
      z.object({
        kind: z.enum([
          'deduplicated',
          'log-compacted',
          'replaced-by-reference',
          'summarized',
          'dropped-irrelevant',
          'truncated',
        ]),
        messageIndex: z.number().int().nonnegative(),
        tokensSaved: z.number().int(),
        reference: z.string().max(300).nullable(),
      }),
    )
    .max(10_000),
  /** True when even the critical set exceeds the budget (caller must not send). */
  overBudget: z.boolean(),
});
export type ContextOptimizationReport = z.infer<typeof ContextOptimizationReportSchema>;

// ---------------------------------------------------------------------------- benchmark
export const BenchmarkCategorySchema = z.enum([
  'instruction-following',
  'structured-output',
  'tool-calling',
  'bugfix',
  'test-generation',
  'code-preservation',
  'context',
]);
export type BenchmarkCategory = z.infer<typeof BenchmarkCategorySchema>;

export const BenchmarkCaseResultSchema = z.object({
  caseId: z.string().max(200),
  category: BenchmarkCategorySchema,
  passed: z.boolean(),
  /** Objective grader detail (schema error, failing test name…), never model self-grading. */
  detail: z.string().max(2000),
  latencyMs: z.number().int().nonnegative().nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  costMicros: Micros.nullable(),
  attempts: z.number().int().nonnegative(),
});
export type BenchmarkCaseResult = z.infer<typeof BenchmarkCaseResultSchema>;

export const BenchmarkRunSchema = z.object({
  id: Id,
  suiteId: Id,
  suiteVersion: z.string().max(50),
  routeId: Id,
  modelId: Id,
  upstreamModelId: z.string().max(300),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema,
  results: z.array(BenchmarkCaseResultSchema).max(1000),
});
export type BenchmarkRun = z.infer<typeof BenchmarkRunSchema>;

export const ModelEvidenceSchema = z.object({
  modelId: Id,
  samples: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative(),
  /** Wilson 95% lower bound — the score used for decisions. */
  wilsonLower: z.number().min(0).max(1),
  confidence: z.enum(['insufficient', 'low', 'moderate', 'high']),
  medianLatencyMs: z.number().nonnegative().nullable(),
  source: z.enum(['benchmark', 'history', 'none']),
  suiteVersions: z.array(z.string()).max(20),
});
export type ModelEvidence = z.infer<typeof ModelEvidenceSchema>;
