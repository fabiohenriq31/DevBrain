import { z } from 'zod';
import { CredentialIdSchema, SessionIdSchema, TimestampSchema } from '../common.js';

// Phase 02 wire contracts. Unknown commercial terms remain null until verified.
const Id = z.string().regex(/^[a-z0-9][a-z0-9._:-]{1,127}$/);
const NonNegative = z.number().finite().nonnegative();
const PositiveInt = z.number().int().positive();
const SafeUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    !url.username &&
    !url.password &&
    (url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  );
}, 'Endpoint must use HTTPS or loopback and contain no credentials');

export const ProviderCatalogEntrySchema = z.object({
  id: Id,
  name: z.string().min(1),
  documentationUrl: SafeUrl,
  kind: z.enum(['api', 'local', 'subscription', 'cli']),
  signupUrl: SafeUrl.nullable(),
  termsUrl: SafeUrl.nullable(),
  sourceId: Id,
  verifiedAt: TimestampSchema.nullable(),
});
export type ProviderCatalogEntry = z.infer<typeof ProviderCatalogEntrySchema>;

export const ProviderEndpointSchema = z.object({
  id: Id,
  providerId: Id,
  baseUrl: SafeUrl,
  protocol: z.enum([
    'openai-chat',
    'openai-responses',
    'anthropic-messages',
    'google-gemini',
    'ollama',
    'custom',
  ]),
  documentationUrl: SafeUrl.nullable(),
});
export type ProviderEndpoint = z.infer<typeof ProviderEndpointSchema>;

export const ProviderConnectionSchema = z.object({
  id: Id,
  providerId: Id,
  endpointId: Id,
  credentialId: CredentialIdSchema.nullable(),
  enabled: z.boolean(),
  status: z.enum(['unknown', 'ready', 'invalid-credential', 'unavailable', 'disabled']),
  lastVerifiedAt: TimestampSchema.nullable(),
});
export type ProviderConnection = z.infer<typeof ProviderConnectionSchema>;

export const ProviderAccountSchema = z.object({
  id: Id,
  connectionId: Id,
  label: z.string().min(1).max(200),
  /** Identity is an opaque user label; never a token or secret. */
  externalId: z.string().max(200).nullable(),
  plan: z.enum(['free', 'trial', 'subscription', 'metered', 'unknown']),
});
export type ProviderAccount = z.infer<typeof ProviderAccountSchema>;

export const ModelCapabilitiesSchema = z.object({
  input: z.array(z.enum(['text', 'image', 'audio', 'video'])).min(1),
  output: z.array(z.enum(['text', 'image', 'audio', 'video'])).min(1),
  tools: z.boolean(),
  streaming: z.boolean(),
  structuredOutput: z.boolean(),
  reasoning: z.boolean(),
  contextTokens: PositiveInt.nullable(),
  outputTokens: PositiveInt.nullable(),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilitiesSchema>;

export const PricingDefinitionSchema = z.object({
  currency: z.string().length(3),
  inputPerMillion: NonNegative.nullable(),
  outputPerMillion: NonNegative.nullable(),
  cachedInputPerMillion: NonNegative.nullable(),
  verifiedAt: TimestampSchema.nullable(),
  sourceUrl: SafeUrl.nullable(),
});
export type PricingDefinition = z.infer<typeof PricingDefinitionSchema>;

export const ModelDefinitionSchema = z.object({
  id: Id,
  providerId: Id,
  upstreamModelId: z.string().min(1).max(300),
  name: z.string().min(1),
  capabilities: ModelCapabilitiesSchema,
  pricing: PricingDefinitionSchema.nullable(),
  lifecycle: z.enum(['active', 'preview', 'deprecated', 'unknown']),
  sourceId: Id,
  verifiedAt: TimestampSchema.nullable(),
});
export type ModelDefinition = z.infer<typeof ModelDefinitionSchema>;

export const ModelAvailabilitySchema = z.object({
  modelId: Id,
  connectionId: Id,
  state: z.enum(['available', 'unavailable', 'rate-limited', 'unknown']),
  observedAt: TimestampSchema,
  retryAt: TimestampSchema.nullable(),
  evidence: z.enum([
    'successful-inference',
    'provider-api',
    'provider-documentation',
    'unverified',
  ]),
});
export type ModelAvailability = z.infer<typeof ModelAvailabilitySchema>;

export const ModelRouteSchema = z.object({
  id: Id,
  modelId: Id,
  connectionId: Id,
  priority: z.number().int().nonnegative(),
  enabled: z.boolean(),
  localOnly: z.boolean(),
});
export type ModelRoute = z.infer<typeof ModelRouteSchema>;

export const QuotaScopeSchema = z.enum([
  'account',
  'organization',
  'credential',
  'provider',
  'endpoint',
  'model',
  'project',
  'ip',
]);
export type QuotaScope = z.infer<typeof QuotaScopeSchema>;
export const QuotaDefinitionSchema = z.object({
  id: Id,
  scope: QuotaScopeSchema,
  scopeId: Id,
  unit: z.enum([
    'requests',
    'input-tokens',
    'output-tokens',
    'reasoning-tokens',
    'cached-tokens',
    'total-tokens',
    'currency',
    'provider-unit',
  ]),
  limit: NonNegative.nullable(),
  periodSeconds: PositiveInt.nullable(),
  sourceUrl: SafeUrl.nullable(),
  verifiedAt: TimestampSchema.nullable(),
});
export type QuotaDefinition = z.infer<typeof QuotaDefinitionSchema>;
export const QuotaObservationSchema = z.object({
  quotaId: Id,
  remaining: NonNegative.nullable(),
  used: NonNegative.nullable(),
  resetAt: TimestampSchema.nullable(),
  observedAt: TimestampSchema,
  source: z.enum(['provider-api', 'response-header', 'user-entered', 'inferred']),
});
export type QuotaObservation = z.infer<typeof QuotaObservationSchema>;
export const QuotaReservationSchema = z.object({
  id: Id,
  quotaId: Id,
  requestId: Id,
  amount: NonNegative,
  status: z.enum(['held', 'committed', 'released', 'expired']),
  expiresAt: TimestampSchema,
});
export type QuotaReservation = z.infer<typeof QuotaReservationSchema>;

export const UsageRecordSchema = z.object({
  id: Id,
  requestId: Id,
  routeId: Id,
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  cost: NonNegative.nullable(),
  currency: z.string().length(3).nullable(),
  source: z.enum(['provider', 'local-meter', 'unknown']),
  recordedAt: TimestampSchema,
});
export type UsageRecord = z.infer<typeof UsageRecordSchema>;
export const CreditBalanceSchema = z.object({
  accountId: Id,
  amount: NonNegative.nullable(),
  currency: z.string().length(3),
  expiresAt: TimestampSchema.nullable(),
  observedAt: TimestampSchema,
  source: z.enum(['provider-api', 'user-entered', 'unknown']),
});
export type CreditBalance = z.infer<typeof CreditBalanceSchema>;

export const BillingPolicySchema = z.object({
  id: Id,
  allowPaid: z.boolean(),
  allowUnknownCost: z.boolean(),
  maxCostPerRequest: NonNegative.nullable(),
  maxCostPerDay: NonNegative.nullable(),
  currency: z.string().length(3),
});
export type BillingPolicy = z.infer<typeof BillingPolicySchema>;
export const PrivacyPolicySchema = z.object({
  id: Id,
  mode: z.enum(['local-only', 'approved-providers', 'any-configured']),
  allowedProviderIds: z.array(Id),
  allowPromptLogging: z.boolean(),
});
export type PrivacyPolicy = z.infer<typeof PrivacyPolicySchema>;
export const RoutingPolicySchema = z.object({
  id: Id,
  strategy: z.enum(['priority', 'lowest-known-cost', 'lowest-latency', 'local-first']),
  billingPolicyId: Id,
  privacyPolicyId: Id,
  maxAttempts: PositiveInt.max(10),
  requireTools: z.boolean(),
});
export type RoutingPolicy = z.infer<typeof RoutingPolicySchema>;
export const RoutingDecisionSchema = z.object({
  requestId: Id,
  routeId: Id,
  policyId: Id,
  selectedAt: TimestampSchema,
  reason: z.string().min(1),
  candidateRouteIds: z.array(Id),
});
export type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;

export const InferenceMessageSchema = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  content: z.string().max(2_000_000),
  toolCallId: z.string().optional(),
});
export const InferenceRequestSchema = z.object({
  id: Id,
  sessionId: SessionIdSchema.nullable(),
  modelId: Id.nullable(),
  messages: z.array(InferenceMessageSchema).min(1),
  maxOutputTokens: PositiveInt.nullable(),
  temperature: z.number().min(0).max(2).nullable(),
  stream: z.boolean(),
  routingPolicyId: Id,
  idempotencyKey: z.string().max(200).nullable(),
});
export type InferenceRequest = z.infer<typeof InferenceRequestSchema>;
export const InferenceErrorSchema = z.object({
  code: z.enum([
    'AUTHENTICATION',
    'RATE_LIMITED',
    'QUOTA_EXCEEDED',
    'PROVIDER_UNAVAILABLE',
    'INVALID_REQUEST',
    'CONTENT_FILTERED',
    'CANCELLED',
    'TIMEOUT',
    'MALFORMED_RESPONSE',
    'UNKNOWN',
  ]),
  message: z.string(),
  retryable: z.boolean(),
  retryAt: TimestampSchema.nullable(),
  providerStatus: z.number().int().min(100).max(599).nullable(),
});
export type InferenceError = z.infer<typeof InferenceErrorSchema>;
export const FallbackAttemptSchema = z.object({
  routeId: Id,
  startedAt: TimestampSchema,
  endedAt: TimestampSchema,
  error: InferenceErrorSchema.nullable(),
});
export type FallbackAttempt = z.infer<typeof FallbackAttemptSchema>;
export const InferenceResultSchema = z.object({
  requestId: Id,
  routeId: Id,
  modelId: Id,
  content: z.string(),
  finishReason: z.enum(['stop', 'length', 'tool-call', 'content-filter', 'unknown']),
  usage: UsageRecordSchema.nullable(),
  attempts: z.array(FallbackAttemptSchema),
  completedAt: TimestampSchema,
});
export type InferenceResult = z.infer<typeof InferenceResultSchema>;
export const InferenceEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('started'),
    requestId: Id,
    seq: z.number().int().nonnegative(),
    routeId: Id,
  }),
  z.object({
    type: z.literal('delta'),
    requestId: Id,
    seq: z.number().int().nonnegative(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('completed'),
    requestId: Id,
    seq: z.number().int().nonnegative(),
    result: InferenceResultSchema,
  }),
  z.object({
    type: z.literal('failed'),
    requestId: Id,
    seq: z.number().int().nonnegative(),
    error: InferenceErrorSchema,
  }),
]);
export type InferenceEvent = z.infer<typeof InferenceEventSchema>;

export const LocalRuntimeSchema = z.object({
  id: Id,
  kind: z.enum(['ollama', 'llama-cpp', 'custom']),
  endpoint: SafeUrl,
  status: z.enum(['available', 'unavailable', 'unknown']),
  version: z.string().nullable(),
});
export type LocalRuntime = z.infer<typeof LocalRuntimeSchema>;
export const LocalModelSchema = z.object({
  id: Id,
  runtimeId: Id,
  modelId: Id,
  sizeBytes: z.number().int().nonnegative().nullable(),
  digest: z.string().nullable(),
  installedAt: TimestampSchema.nullable(),
});
export type LocalModel = z.infer<typeof LocalModelSchema>;
export const HardwareProfileSchema = z.object({
  platform: z.string(),
  cpuCores: PositiveInt,
  memoryBytes: PositiveInt,
  gpuName: z.string().nullable(),
  gpuMemoryBytes: z.number().int().nonnegative().nullable(),
  measuredAt: TimestampSchema,
});
export type HardwareProfile = z.infer<typeof HardwareProfileSchema>;
export const BenchmarkResultSchema = z.object({
  id: Id,
  runtimeId: Id,
  modelId: Id,
  hardware: HardwareProfileSchema,
  tokensPerSecond: NonNegative.nullable(),
  timeToFirstTokenMs: NonNegative.nullable(),
  success: z.boolean(),
  measuredAt: TimestampSchema,
});
export type BenchmarkResult = z.infer<typeof BenchmarkResultSchema>;
export const CatalogSourceSchema = z.object({
  id: Id,
  name: z.string().min(1),
  url: SafeUrl,
  license: z.string().nullable(),
  revision: z.string().nullable(),
  lastFetchedAt: TimestampSchema.nullable(),
});
export type CatalogSource = z.infer<typeof CatalogSourceSchema>;
export const CatalogSnapshotSchema = z.object({
  id: Id,
  sourceId: Id,
  revision: z.string().nullable(),
  fetchedAt: TimestampSchema,
  providerCount: z.number().int().nonnegative(),
  modelCount: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CatalogSnapshot = z.infer<typeof CatalogSnapshotSchema>;
export const TaskCheckpointSchema = z.object({
  id: Id,
  sessionId: SessionIdSchema,
  requestId: Id,
  state: z.enum(['ready', 'interrupted', 'completed']),
  summary: z.string().max(20_000),
  createdAt: TimestampSchema,
});
export type TaskCheckpoint = z.infer<typeof TaskCheckpointSchema>;

/** Secret material is intentionally absent. Reuse CredentialReference from records.ts. */
export const AiResourceIdSchema = Id;
export const AiResourceSafeUrlSchema = SafeUrl;
