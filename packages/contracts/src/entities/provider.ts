import { z } from 'zod';
import {
  CredentialIdSchema,
  NonEmptyStringSchema,
  ProviderIdSchema,
  TimestampSchema,
} from '../common.js';

/**
 * - `cli-agent`: an installed agent CLI driven as a child process.
 * - `http-api`: a remote model API reached over HTTPS.
 * - `local-model`: a model server on this machine (e.g. an Ollama-compatible endpoint).
 */
export const ProviderKindSchema = z.enum(['cli-agent', 'http-api', 'local-model']);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const EnforcementLevelSchema = z.enum(['per-action', 'adapter-sandbox', 'none']);
export type EnforcementLevel = z.infer<typeof EnforcementLevelSchema>;

export const CostModelSchema = z.enum(['free', 'subscription', 'metered', 'local', 'unknown']);
export type CostModel = z.infer<typeof CostModelSchema>;

/**
 * What an integration can actually do. Adapters must report only verified capabilities;
 * unknown means `false`/`null`, never an assumption.
 */
export const AgentCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  interrupt: z.boolean(),
  resumeSession: z.boolean(),
  toolUse: z.boolean(),
  fileEdits: z.boolean(),
  shellCommands: z.boolean(),
  mcp: z.boolean(),
  structuredOutput: z.boolean(),
  maxConcurrentSessions: z.number().int().min(1).nullable(),
  contextWindowTokens: z.number().int().min(1).nullable(),
  costModel: CostModelSchema,
  /**
   * @since 0.2.0 — how far DevBrain can enforce permissions on this integration.
   * - `per-action`: every file/command/network action passes through DevBrain (tool proxy).
   * - `adapter-sandbox`: the agent enforces a restrictive mode DevBrain configured
   *   (e.g. read-only / workspace-write), but individual actions are not intercepted.
   * - `none`: DevBrain cannot intercept or constrain actions (only cwd + approval at start).
   * Missing = `none` (most restrictive interpretation).
   */
  enforcement: EnforcementLevelSchema.optional(),
});
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;

/** Conservative default: nothing is assumed to be supported. */
export const NO_CAPABILITIES: AgentCapabilities = Object.freeze({
  streaming: false,
  interrupt: false,
  resumeSession: false,
  toolUse: false,
  fileEdits: false,
  shellCommands: false,
  mcp: false,
  structuredOutput: false,
  maxConcurrentSessions: null,
  contextWindowTokens: null,
  costModel: 'unknown',
});

export const ProviderStatusSchema = z.enum([
  'unknown',
  'available',
  'missing-dependency',
  'unauthenticated',
  'quota-exhausted',
  'unavailable',
  'disabled',
]);
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export const AdapterKeySchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/);

export const ProviderSchema = z.object({
  id: ProviderIdSchema,
  /** Stable adapter key, e.g. `claude-code-cli`. Matches `ProviderAdapter.key`. */
  adapterKey: AdapterKeySchema,
  kind: ProviderKindSchema,
  displayName: NonEmptyStringSchema.max(200),
  vendor: z.string().max(200).nullable(),
  status: ProviderStatusSchema,
  enabled: z.boolean(),
  /** Reference to a stored secret; the secret itself never appears in contracts. */
  credentialRef: CredentialIdSchema.nullable(),
  /** For `local-model` / `http-api`: base URL. Must not embed credentials. */
  endpoint: z
    .url()
    .refine((u) => !/\/\/[^/]*@/.test(u), 'Endpoint must not embed credentials')
    .nullable(),
  capabilities: AgentCapabilitiesSchema,
  lastCheckedAt: TimestampSchema.nullable(),
});
export type Provider = z.infer<typeof ProviderSchema>;

export const DependencyCheckSchema = z.object({
  name: NonEmptyStringSchema,
  required: z.boolean(),
  found: z.boolean(),
  version: z.string().nullable(),
  minimumVersion: z.string().nullable(),
  /** Absolute path to the resolved executable, when applicable. */
  resolvedPath: z.string().nullable(),
  message: z.string().nullable(),
});
export type DependencyCheck = z.infer<typeof DependencyCheckSchema>;

export const DependencyReportSchema = z.object({
  adapterKey: AdapterKeySchema,
  status: ProviderStatusSchema,
  checks: z.array(DependencyCheckSchema),
  checkedAt: TimestampSchema,
});
export type DependencyReport = z.infer<typeof DependencyReportSchema>;

/** Description of an adapter known to the application (installed or not). */
export const AdapterDescriptorSchema = z.object({
  adapterKey: AdapterKeySchema,
  kind: ProviderKindSchema,
  displayName: NonEmptyStringSchema,
  vendor: z.string().nullable(),
  /** URL of the official documentation the adapter was implemented against. */
  documentationUrl: z.url().nullable(),
  capabilities: AgentCapabilitiesSchema,
});
export type AdapterDescriptor = z.infer<typeof AdapterDescriptorSchema>;
