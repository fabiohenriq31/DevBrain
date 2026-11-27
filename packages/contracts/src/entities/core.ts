/**
 * Contracts added in 0.2.0 (Phase 01, core block): project settings, provider
 * configuration and health evidence, credentials input, session history, permission
 * grants, usage accounting and maintenance.
 */
import { z } from 'zod';
import {
  AbsolutePathSchema,
  AgentIdSchema,
  ApprovalIdSchema,
  CheckpointIdSchema,
  CredentialIdSchema,
  ExecutionIdSchema,
  GrantIdSchema,
  NonEmptyStringSchema,
  PolicyIdSchema,
  ProjectIdSchema,
  ProviderIdSchema,
  SessionIdSchema,
  TimestampSchema,
  WorkspaceIdSchema,
} from '../common.js';
import { AgentSessionSchema } from './agent.js';
import {
  ExecutionRequestSchema,
  ExecutionResultSchema,
  ExecutionStatusSchema,
  UsageSchema,
} from './execution.js';
import { ApprovalScopeSchema, PermissionActionSchema } from './permissions.js';
import { CheckpointSchema } from './records.js';
import {
  AdapterKeySchema,
  AgentCapabilitiesSchema,
  ProviderKindSchema,
  ProviderSchema,
} from './provider.js';

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/** Windows-safe folder name (no separators, reserved names or trailing dot/space). */
export const FolderNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((n) => !/[<>:"/\\|?*]/.test(n) && !/[. ]$/.test(n), 'Invalid folder name')
  .refine((n) => !/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n), 'Reserved name');

export const CreateProjectInputSchema = z.object({
  /** Existing directory where the new project folder is created. */
  parentPath: AbsolutePathSchema,
  folderName: FolderNameSchema,
  name: NonEmptyStringSchema.max(200).optional(),
  description: z.string().max(4000).optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>;

/** Removes the registration only. Files on disk are never touched. */
export const RemoveProjectInputSchema = z.object({
  id: ProjectIdSchema,
  /** Explicit confirmation: removes sessions/executions/checkpoints history of the project. */
  confirm: z.literal(true),
});
export type RemoveProjectInput = z.infer<typeof RemoveProjectInputSchema>;

export const ProviderPreferenceSchema = z.object({
  providerId: ProviderIdSchema,
  enabled: z.boolean(),
  model: z.string().max(200).nullable(),
  /** Lower = preferred. */
  priority: z.number().int().min(0).max(1000),
});
export type ProviderPreference = z.infer<typeof ProviderPreferenceSchema>;

export const ProjectSettingsSchema = z.object({
  projectId: ProjectIdSchema,
  preferredAgentId: AgentIdSchema.nullable(),
  /** Overrides the agent policy inside this project (most restrictive wins). */
  permissionPolicyId: PolicyIdSchema.nullable(),
  providerPreferences: z.array(ProviderPreferenceSchema).max(50),
  /** Workspace-relative globs never exposed to agents (in addition to defaults). */
  excludedPaths: z.array(z.string().min(1).max(500)).max(200),
  notes: z.string().max(10_000).nullable(),
  updatedAt: TimestampSchema,
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export const ProjectSettingsPatchSchema = z.object({
  projectId: ProjectIdSchema,
  preferredAgentId: AgentIdSchema.nullable().optional(),
  permissionPolicyId: PolicyIdSchema.nullable().optional(),
  providerPreferences: z.array(ProviderPreferenceSchema).max(50).optional(),
  excludedPaths: z.array(z.string().min(1).max(500)).max(200).optional(),
  notes: z.string().max(10_000).nullable().optional(),
});
export type ProjectSettingsPatch = z.infer<typeof ProjectSettingsPatchSchema>;

export const UpdateWorkspaceAccessInputSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  /** Must contain the workspace root. Extra roots must exist and are validated. */
  allowedRoots: z.array(AbsolutePathSchema).min(1).max(20),
  readOnlyRoots: z.array(AbsolutePathSchema).max(20),
  allowNetwork: z.boolean(),
});
export type UpdateWorkspaceAccessInput = z.infer<typeof UpdateWorkspaceAccessInputSchema>;

export const RecentProjectsInputSchema = z.object({
  limit: z.number().int().min(1).max(50).default(10),
});

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export const ProviderModelSchema = z.object({
  id: z.string().min(1).max(200),
  displayName: z.string().max(200).nullable(),
});

export const ProviderConfigSchema = z.object({
  /** Executable for `cli-agent` providers; null = resolve from PATH by the engine. */
  executablePath: AbsolutePathSchema.nullable(),
  /** Extra arguments always passed (validated by the adapter, never a shell string). */
  defaultArgs: z.array(z.string().max(1000)).max(50),
  models: z.array(ProviderModelSchema).max(200),
  defaultModel: z.string().max(200).nullable(),
  /** Environment variable NAMES forwarded to the process (values resolved in main). */
  envAllowlist: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(50),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const EMPTY_PROVIDER_CONFIG: ProviderConfig = Object.freeze({
  executablePath: null,
  defaultArgs: [],
  models: [],
  defaultModel: null,
  envAllowlist: [],
}) as ProviderConfig;

/** A fact about a provider, only ever produced by the execution engine (main process). */
export const EvidenceSchema = z.object({
  state: z.enum(['unknown', 'yes', 'no']),
  checkedAt: TimestampSchema.nullable(),
  source: z.enum(['none', 'execution-engine']),
  /** Redacted detail, e.g. detected version or failure reason. */
  detail: z.string().max(2000).nullable(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const UNKNOWN_EVIDENCE: Evidence = Object.freeze({
  state: 'unknown',
  checkedAt: null,
  source: 'none',
  detail: null,
}) as Evidence;

export const ProviderHealthSchema = z.object({
  /** Executable / server found (dependency check). */
  installed: EvidenceSchema,
  /** Credentials or login accepted by the provider. */
  authenticated: EvidenceSchema,
  /** A real request/session succeeded recently. */
  operational: EvidenceSchema,
});
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;

/**
 * Readiness ladder, derived (never stored):
 * disabled < configured < available (installed) < authenticated < operational.
 * `failing` = a later check contradicted an earlier success.
 */
export const ProviderReadinessSchema = z.enum([
  'disabled',
  'configured',
  'available',
  'authenticated',
  'operational',
  'failing',
]);
export type ProviderReadiness = z.infer<typeof ProviderReadinessSchema>;

export const ProviderProfileSchema = z.object({
  provider: ProviderSchema,
  config: ProviderConfigSchema,
  health: ProviderHealthSchema,
  readiness: ProviderReadinessSchema,
});
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;

export const RegisterProviderInputSchema = z.object({
  adapterKey: AdapterKeySchema,
  kind: ProviderKindSchema,
  displayName: NonEmptyStringSchema.max(200),
  vendor: z.string().max(200).nullable().optional(),
  endpoint: ProviderSchema.shape.endpoint.optional(),
  credentialRef: CredentialIdSchema.nullable().optional(),
  config: ProviderConfigSchema.partial().optional(),
});
export type RegisterProviderInput = z.infer<typeof RegisterProviderInputSchema>;

export const UpdateProviderInputSchema = z.object({
  id: ProviderIdSchema,
  displayName: NonEmptyStringSchema.max(200).optional(),
  vendor: z.string().max(200).nullable().optional(),
  endpoint: ProviderSchema.shape.endpoint.optional(),
  credentialRef: CredentialIdSchema.nullable().optional(),
  config: ProviderConfigSchema.partial().optional(),
});
export type UpdateProviderInput = z.infer<typeof UpdateProviderInputSchema>;

export const SetProviderEnabledInputSchema = z.object({
  id: ProviderIdSchema,
  enabled: z.boolean(),
});

/** Reported by the execution engine via `ProviderService.recordEvidence` (no IPC). */
export const ProviderEvidenceInputSchema = z.object({
  providerId: ProviderIdSchema,
  aspect: z.enum(['installed', 'authenticated', 'operational']),
  state: z.enum(['yes', 'no']),
  detail: z.string().max(2000).nullable(),
  /** Verified capabilities, when the check revealed them. */
  capabilities: AgentCapabilitiesSchema.optional(),
});
export type ProviderEvidenceInput = z.infer<typeof ProviderEvidenceInputSchema>;

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export const RegisterAgentInputSchema = z.object({
  providerId: ProviderIdSchema,
  name: NonEmptyStringSchema.max(200),
  role: z.string().max(200).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  /** Defaults to a fresh restrictive policy. */
  permissionPolicyId: PolicyIdSchema.optional(),
});
export type RegisterAgentInput = z.infer<typeof RegisterAgentInputSchema>;

export const UpdateAgentInputSchema = z.object({
  id: AgentIdSchema,
  name: NonEmptyStringSchema.max(200).optional(),
  role: z.string().max(200).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  permissionPolicyId: PolicyIdSchema.optional(),
  status: z.enum(['idle', 'paused', 'disabled']).optional(),
});
export type UpdateAgentInput = z.infer<typeof UpdateAgentInputSchema>;

// ---------------------------------------------------------------------------
// Credentials (input only — values flow renderer -> main, never back)
// ---------------------------------------------------------------------------

export const StoreCredentialInputSchema = z.discriminatedUnion('storage', [
  z.object({
    storage: z.literal('os-encrypted'),
    label: NonEmptyStringSchema.max(200),
    providerId: ProviderIdSchema.nullable().optional(),
    secret: z
      .string()
      .min(1)
      .max(64 * 1024),
  }),
  z.object({
    storage: z.literal('environment'),
    label: NonEmptyStringSchema.max(200),
    providerId: ProviderIdSchema.nullable().optional(),
    variable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
  }),
]);
export type StoreCredentialInput = z.infer<typeof StoreCredentialInputSchema>;

export const CredentialRefInputSchema = z.object({ id: CredentialIdSchema });

// ---------------------------------------------------------------------------
// Sessions & history
// ---------------------------------------------------------------------------

export const SessionFileSchema = z.object({
  sessionId: SessionIdSchema,
  executionId: ExecutionIdSchema.nullable(),
  /** Workspace-relative, `/`-separated. */
  path: z.string().min(1).max(4096),
  change: z.enum(['read', 'created', 'modified', 'deleted', 'renamed', 'referenced']),
  recordedAt: TimestampSchema,
});
export type SessionFile = z.infer<typeof SessionFileSchema>;

export const ExecutionRecordSchema = z.object({
  request: ExecutionRequestSchema,
  status: ExecutionStatusSchema,
  result: ExecutionResultSchema.nullable(),
  eventCount: z.number().int().nonnegative(),
  outputTruncated: z.boolean(),
});
export type ExecutionRecord = z.infer<typeof ExecutionRecordSchema>;

export const SessionHistorySchema = z.object({
  session: AgentSessionSchema,
  executions: z.array(ExecutionRecordSchema),
  files: z.array(SessionFileSchema),
  checkpoints: z.array(CheckpointSchema),
});
export type SessionHistory = z.infer<typeof SessionHistorySchema>;

export const ListSessionsInputSchema = z.object({
  projectId: ProjectIdSchema,
  status: z.array(AgentSessionSchema.shape.status).optional(),
  limit: z.number().int().min(1).max(500).default(100),
});
export type ListSessionsInput = z.input<typeof ListSessionsInputSchema>;

export const CHECKPOINT_STATE_VERSION = 1 as const;

/**
 * Structured, provider-neutral checkpoint state (v1). Designed to seed the future shared
 * memory (Phase 02): every field is plain data with provenance kept in the checkpoint.
 */
export const CheckpointStateV1Schema = z.object({
  version: z.literal(CHECKPOINT_STATE_VERSION),
  task: z.string().max(20_000).nullable(),
  plan: z.array(z.string().max(2000)).max(200),
  summary: z.string().max(50_000).nullable(),
  filesTouched: z.array(z.string().max(4096)).max(5000),
  nextSteps: z.array(z.string().max(2000)).max(200),
  /** Provider resume handle, if the provider supports it (not a promise of resumption). */
  providerRef: z
    .object({ adapterKey: AdapterKeySchema, externalSessionId: z.string().max(500) })
    .nullable(),
  lastExecutionId: ExecutionIdSchema.nullable(),
});
export type CheckpointStateV1 = z.infer<typeof CheckpointStateV1Schema>;

export const SaveCheckpointInputSchema = z.object({
  sessionId: SessionIdSchema,
  label: z.string().max(500),
  gitCommit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .nullable()
    .optional(),
  state: CheckpointStateV1Schema,
});
export type SaveCheckpointInput = z.infer<typeof SaveCheckpointInputSchema>;

// ---------------------------------------------------------------------------
// Permission grants
// ---------------------------------------------------------------------------

/** A human decision that pre-approves an action within a scope, until expiry/revocation. */
export const PermissionGrantSchema = z.object({
  id: GrantIdSchema,
  approvalId: ApprovalIdSchema,
  agentId: AgentIdSchema,
  projectId: ProjectIdSchema.nullable(),
  sessionId: SessionIdSchema.nullable(),
  action: PermissionActionSchema,
  scope: ApprovalScopeSchema.exclude(['once']),
  /** Glob (paths) or executable name the grant is limited to; null = any target. */
  target: z.string().max(4096).nullable(),
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable(),
  revokedReason: z.string().max(500).nullable(),
});
export type PermissionGrant = z.infer<typeof PermissionGrantSchema>;

export const ListGrantsInputSchema = z.object({
  agentId: AgentIdSchema.optional(),
  projectId: ProjectIdSchema.optional(),
  includeInactive: z.boolean().default(false),
});

export const RevokeGrantInputSchema = z.object({
  id: GrantIdSchema,
  reason: z.string().max(500).optional(),
});

export const EvaluatePermissionInputSchema = z.object({
  agentId: AgentIdSchema,
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema.optional(),
  action: PermissionActionSchema,
  /** Absolute or workspace-relative path. */
  path: z.string().max(4096).optional(),
  executable: z.string().max(1024).optional(),
  untrustedOrigin: z.boolean().default(false),
});
export type EvaluatePermissionInput = z.input<typeof EvaluatePermissionInputSchema>;

export const PermissionVerdictSchema = z.object({
  decision: z.enum(['allow', 'ask', 'deny']),
  reason: z.string(),
  grantId: GrantIdSchema.nullable().default(null),
});

// ---------------------------------------------------------------------------
// Usage & budget
// ---------------------------------------------------------------------------

export const UsageSummaryInputSchema = z.object({
  period: z.enum(['day', 'month']).default('day'),
  projectId: ProjectIdSchema.optional(),
  agentId: AgentIdSchema.optional(),
});

export const UsageSummarySchema = z.object({
  period: z.enum(['day', 'month']),
  since: TimestampSchema,
  executions: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** Per currency. */
  cost: z.record(z.string(), z.number().nonnegative()),
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;

export const UsageRecordInputSchema = z.object({
  executionId: ExecutionIdSchema,
  agentId: AgentIdSchema,
  providerId: ProviderIdSchema.nullable(),
  projectId: ProjectIdSchema.nullable(),
  usage: UsageSchema,
});
export type UsageRecordInput = z.infer<typeof UsageRecordInputSchema>;

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

export const BackupResultSchema = z.object({
  path: AbsolutePathSchema,
  bytes: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
});
export type BackupResult = z.infer<typeof BackupResultSchema>;

export const StorageHealthSchema = z.object({
  schemaVersion: z.number().int().nonnegative(),
  integrity: z.enum(['ok', 'recovered-from-backup', 'recreated']),
  /** Previous run did not shut down cleanly. */
  uncleanShutdownDetected: z.boolean(),
  /** Sessions/executions marked interrupted during this startup's recovery. */
  recoveredSessions: z.number().int().nonnegative(),
  recoveredExecutions: z.number().int().nonnegative(),
  lastBackupAt: TimestampSchema.nullable(),
  databaseBytes: z.number().int().nonnegative(),
});
export type StorageHealth = z.infer<typeof StorageHealthSchema>;

export const PruneResultSchema = z.object({
  executionEvents: z.number().int().nonnegative(),
  auditEvents: z.number().int().nonnegative(),
  expiredApprovals: z.number().int().nonnegative(),
  expiredGrants: z.number().int().nonnegative(),
});
export type PruneResult = z.infer<typeof PruneResultSchema>;

export const ProjectExportSchema = z.object({
  format: z.literal('devbrain.project-export'),
  version: z.literal(1),
  exportedAt: TimestampSchema,
  project: z.unknown(),
  workspaces: z.array(z.unknown()),
  settings: z.unknown().nullable(),
  sessions: z.array(z.unknown()),
  executions: z.array(z.unknown()),
  checkpoints: z.array(z.unknown()),
});
export type ProjectExport = z.infer<typeof ProjectExportSchema>;

export const CheckpointRefInputSchema = z.object({ id: CheckpointIdSchema });
