import { z } from 'zod';
import {
  AbsolutePathSchema,
  AuditIdSchema,
  CheckpointIdSchema,
  CredentialIdSchema,
  NonEmptyStringSchema,
  patchOf,
  ProjectIdSchema,
  ProviderIdSchema,
  SessionIdSchema,
  TimestampSchema,
  WorkspaceIdSchema,
} from '../common.js';
import { PermissionActionSchema } from './permissions.js';

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Where a secret lives. Contracts only ever carry the *reference*; secret values stay in
 * the Electron main process and are never sent to the renderer, logs or agents' prompts.
 */
export const CredentialStorageSchema = z.enum([
  /** Encrypted with Electron `safeStorage` (DPAPI on Windows) and stored locally. */
  'os-encrypted',
  /** Read from an environment variable of the main process at use time. */
  'environment',
]);
export type CredentialStorage = z.infer<typeof CredentialStorageSchema>;

export const CredentialReferenceSchema = z.object({
  id: CredentialIdSchema,
  label: NonEmptyStringSchema.max(200),
  providerId: ProviderIdSchema.nullable(),
  storage: CredentialStorageSchema,
  /** For `environment`: variable name. For `os-encrypted`: opaque storage key. */
  locator: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/),
  /** Last 4 characters at most, for display. */
  hint: z.string().max(4).nullable(),
  createdAt: TimestampSchema,
  lastUsedAt: TimestampSchema.nullable(),
});
export type CredentialReference = z.infer<typeof CredentialReferenceSchema>;

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

export const GitRemoteSchema = z.object({
  name: z.string().min(1),
  /** Credentials embedded in URLs must be stripped before reaching this contract. */
  url: z
    .string()
    .refine((u) => !/\/\/[^/@]+:[^/@]*@/.test(u), 'Remote URL must not embed credentials'),
});

export const GitWorktreeSchema = z.object({
  path: AbsolutePathSchema,
  branch: z.string().nullable(),
  head: z.string().nullable(),
  isMain: z.boolean(),
  locked: z.boolean(),
});

export const GitRepositorySchema = z.object({
  rootPath: AbsolutePathSchema,
  gitDir: AbsolutePathSchema,
  isBare: z.boolean(),
  headBranch: z.string().nullable(),
  headCommit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .nullable(),
  remotes: z.array(GitRemoteSchema),
  worktrees: z.array(GitWorktreeSchema),
});
export type GitRepository = z.infer<typeof GitRepositorySchema>;

export const GitFileStatusSchema = z.object({
  path: z.string(),
  originalPath: z.string().nullable(),
  index: z.enum([
    'unmodified',
    'modified',
    'added',
    'deleted',
    'renamed',
    'copied',
    'untracked',
    'ignored',
    'conflicted',
  ]),
  workTree: z.enum([
    'unmodified',
    'modified',
    'added',
    'deleted',
    'renamed',
    'copied',
    'untracked',
    'ignored',
    'conflicted',
  ]),
});

export const GitStatusSchema = z.object({
  rootPath: AbsolutePathSchema,
  branch: z.string().nullable(),
  detached: z.boolean(),
  upstream: z.string().nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  files: z.array(GitFileStatusSchema),
  clean: z.boolean(),
  capturedAt: TimestampSchema,
});
export type GitStatus = z.infer<typeof GitStatusSchema>;

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

export const CHECKPOINT_SCHEMA_VERSION = 1 as const;

/** Durable resume point for an interrupted session / task (also used for failover). */
export const CheckpointSchema = z.object({
  id: CheckpointIdSchema,
  projectId: ProjectIdSchema,
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema.nullable(),
  label: z.string().max(500),
  /** Commit capturing the workspace code at checkpoint time, if any. */
  gitCommit: z
    .string()
    .regex(/^[0-9a-f]{7,64}$/)
    .nullable(),
  /** Versioned, provider-neutral state needed to resume (task, plan, summary...). */
  schemaVersion: z.number().int().min(1),
  state: z.record(z.string(), z.unknown()),
  createdAt: TimestampSchema,
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const AuditActorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user') }),
  z.object({ type: z.literal('agent'), agentId: z.string() }),
  z.object({ type: z.literal('system'), component: z.string() }),
]);
export type AuditActor = z.infer<typeof AuditActorSchema>;

export const AuditOutcomeSchema = z.enum(['success', 'failure', 'denied', 'pending']);

/** Append-only. Details are redacted before persistence. */
export const AuditEventSchema = z.object({
  id: AuditIdSchema,
  timestamp: TimestampSchema,
  actor: AuditActorSchema,
  /** Dotted action name, e.g. `project.registered`, `approval.decided`. */
  action: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/),
  permission: PermissionActionSchema.nullable(),
  projectId: ProjectIdSchema.nullable(),
  target: z.string().max(4096).nullable(),
  outcome: AuditOutcomeSchema,
  details: z.record(z.string(), z.unknown()),
  correlationId: z.string().max(200).nullable(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type AuditEventInput = Omit<AuditEvent, 'id' | 'timestamp'>;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const SETTINGS_SCHEMA_VERSION = 1 as const;

export const RetentionSettingsSchema = z.object({
  /** Execution events older than this (of finished executions) are pruned. */
  executionEventsMaxAgeDays: z.number().int().min(1).max(3650),
  /** Hard cap of stored events per execution; extra output is dropped and flagged. */
  maxEventsPerExecution: z.number().int().min(100).max(1_000_000),
  /** Bytes of output text stored per execution (beyond that, chunks are truncated). */
  maxStoredOutputBytesPerExecution: z
    .number()
    .int()
    .min(64 * 1024)
    .max(1024 * 1024 * 1024),
  /** Audit rows older than this are pruned (a signed summary row is kept). */
  auditMaxAgeDays: z.number().int().min(30).max(3650),
  /** Log files: size per file and number of rotated files kept. */
  logMaxFileBytes: z
    .number()
    .int()
    .min(64 * 1024)
    .max(512 * 1024 * 1024),
  logMaxFiles: z.number().int().min(1).max(50),
  /** Automatic local backups kept. */
  backupsToKeep: z.number().int().min(1).max(100),
});
export type RetentionSettings = z.infer<typeof RetentionSettingsSchema>;

export const DEFAULT_RETENTION: RetentionSettings = Object.freeze({
  executionEventsMaxAgeDays: 30,
  maxEventsPerExecution: 50_000,
  maxStoredOutputBytesPerExecution: 32 * 1024 * 1024,
  auditMaxAgeDays: 365,
  logMaxFileBytes: 5 * 1024 * 1024,
  logMaxFiles: 5,
  backupsToKeep: 5,
});

export const ApplicationSettingsSchema = z.object({
  schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION),
  language: z.enum(['pt-BR', 'en']),
  theme: z.enum(['system', 'light', 'dark']),
  execution: z.object({
    maxConcurrentExecutions: z.number().int().min(1).max(64),
    defaultTimeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(24 * 60 * 60 * 1000),
    /** @since 0.2.0 */
    maxConcurrentPerAgent: z.number().int().min(1).max(64).default(2),
  }),
  security: z.object({
    /** Approval timeout; expired requests are denied. */
    approvalTimeoutMs: z
      .number()
      .int()
      .min(10_000)
      .max(24 * 60 * 60 * 1000),
    /** Additional actions that require approval (on top of ALWAYS_ASK_ACTIONS). */
    extraApprovalActions: z.array(PermissionActionSchema),
    /** @since 0.2.0 — default lifetime of session/project grants. */
    defaultGrantTtlMs: z
      .number()
      .int()
      .min(60_000)
      .max(30 * 24 * 60 * 60 * 1000)
      .default(8 * 60 * 60 * 1000),
  }),
  /** @since 0.2.0 — bounds growth of logs and history. */
  retention: RetentionSettingsSchema.default(DEFAULT_RETENTION),
  /** @since 0.2.0 — global consumption limits (null = unlimited). */
  budget: z
    .object({
      currency: z.string().length(3),
      maxPerDay: z.number().nonnegative().nullable(),
      maxPerMonth: z.number().nonnegative().nullable(),
      /**
       * @since 0.4.0 — explicit, informed opt-in to run cost-bearing executions whose cost the
       * integration cannot report while a limit is configured. Limits are then checked only
       * against REPORTED spending and are not a guarantee. Default `false`: such executions
       * are blocked with `BUDGET_UNENFORCEABLE`.
       */
      allowWithoutCostGuarantee: z.boolean().default(false),
    })
    .default({
      currency: 'USD',
      maxPerDay: null,
      maxPerMonth: null,
      allowWithoutCostGuarantee: false,
    }),
  /** DevBrain has no telemetry; kept explicit so it cannot be silently enabled. */
  telemetry: z.literal(false),
});
export type ApplicationSettings = z.infer<typeof ApplicationSettingsSchema>;

export const DEFAULT_SETTINGS: ApplicationSettings = Object.freeze({
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  language: 'pt-BR',
  theme: 'system',
  execution: {
    maxConcurrentExecutions: 4,
    defaultTimeoutMs: 30 * 60 * 1000,
    maxConcurrentPerAgent: 2,
  },
  security: {
    approvalTimeoutMs: 15 * 60 * 1000,
    extraApprovalActions: [],
    defaultGrantTtlMs: 8 * 60 * 60 * 1000,
  },
  retention: { ...DEFAULT_RETENTION },
  budget: { currency: 'USD', maxPerDay: null, maxPerMonth: null, allowWithoutCostGuarantee: false },
  telemetry: false,
}) as ApplicationSettings;

export const SettingsPatchSchema = z.object({
  language: ApplicationSettingsSchema.shape.language.optional(),
  theme: ApplicationSettingsSchema.shape.theme.optional(),
  execution: patchOf(ApplicationSettingsSchema.shape.execution).optional(),
  security: patchOf(ApplicationSettingsSchema.shape.security).optional(),
  retention: patchOf(RetentionSettingsSchema).optional(),
  budget: z
    .object({
      currency: z.string().length(3),
      maxPerDay: z.number().nonnegative().nullable(),
      maxPerMonth: z.number().nonnegative().nullable(),
      allowWithoutCostGuarantee: z.boolean(),
    })
    .partial()
    .optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
