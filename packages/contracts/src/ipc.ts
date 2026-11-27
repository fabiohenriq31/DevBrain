import { z } from 'zod';
import * as C from './entities/core.js';
import { AgentSchema } from './entities/agent.js';
import { CheckpointSchema, CredentialReferenceSchema } from './entities/records.js';
import { PermissionPolicySchema } from './entities/permissions.js';
import { WorkspaceSchema } from './entities/project.js';
import {
  AuditEventSchema,
  ApplicationSettingsSchema,
  SettingsPatchSchema,
} from './entities/records.js';
import {
  ListProjectsInputSchema,
  ProjectRefInputSchema,
  ProjectSchema,
  RegisterProjectInputSchema,
  UpdateProjectInputSchema,
} from './entities/project.js';
import {
  AdapterDescriptorSchema,
  AdapterKeySchema,
  AgentCapabilitiesSchema,
  DependencyReportSchema,
} from './entities/provider.js';
import {
  AgentSessionSchema,
  SessionRefInputSchema,
  StartSessionInputSchema,
} from './entities/agent.js';
import {
  ExecutionEventSchema,
  ExecutionRefInputSchema,
  ExecutionResultSchema,
  ExecutionStatusSchema,
  InterruptInputSchema,
  ListExecutionEventsInputSchema,
  ExecutionPayloadSchema,
} from './entities/execution.js';
import { ApprovalDecisionInputSchema, ApprovalRequestSchema } from './entities/permissions.js';
import {
  AbsolutePathSchema,
  ExecutionIdSchema,
  ProjectIdSchema,
  ProviderIdSchema,
  SessionIdSchema,
} from './common.js';
import {
  DevBrainError,
  DevBrainErrorSchema,
  toErrorPayload,
  type DevBrainErrorPayload,
} from './errors.js';
import { CONTRACTS_VERSION, IPC_PROTOCOL_VERSION } from './version.js';

/**
 * Typed, allowlisted IPC between Electron Main, Preload and Renderer.
 *
 * - The renderer can only call channels declared in `IPC_CHANNELS`.
 * - Every request and event payload is validated with zod in the main process
 *   (trust boundary). Responses are validated too, to catch contract drift early.
 * - Channel wire names embed the protocol major: `devbrain:v1:<key>`.
 */
export interface ChannelDefinition<
  Req extends z.ZodType = z.ZodType,
  Res extends z.ZodType = z.ZodType,
> {
  readonly request: Req;
  readonly response: Res;
  readonly description: string;
}

const channel = <Req extends z.ZodType, Res extends z.ZodType>(
  request: Req,
  response: Res,
  description: string,
): ChannelDefinition<Req, Res> => ({ request, response, description });

const Empty = z.object({}).strict();

export const SystemInfoSchema = z.object({
  appVersion: z.string(),
  contractsVersion: z.string(),
  platform: z.enum(['win32', 'darwin', 'linux']),
  electronVersion: z.string().nullable(),
  nodeVersion: z.string(),
  dataDirectoryConfigured: z.boolean(),
});
export type SystemInfo = z.infer<typeof SystemInfoSchema>;

export const SubmitExecutionInputSchema = z.object({
  sessionId: SessionIdSchema,
  payload: ExecutionPayloadSchema,
  workingDirectory: AbsolutePathSchema.optional(),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .max(24 * 60 * 60 * 1000)
    .optional(),
  idempotencyKey: z.string().min(8).max(200).optional(),
});
export type SubmitExecutionInput = z.input<typeof SubmitExecutionInputSchema>;

export const ExecutionHandleSchema = z.object({
  executionId: ExecutionIdSchema,
  status: ExecutionStatusSchema,
});
export type ExecutionHandle = z.infer<typeof ExecutionHandleSchema>;

export const IPC_CHANNELS = {
  'system.getInfo': channel(Empty, SystemInfoSchema, 'Application and runtime information.'),

  'projects.list': channel(
    ListProjectsInputSchema,
    z.array(ProjectSchema),
    'List registered projects.',
  ),
  'projects.get': channel(ProjectRefInputSchema, ProjectSchema, 'Get one project.'),
  'projects.register': channel(
    RegisterProjectInputSchema,
    ProjectSchema,
    'Register an existing directory.',
  ),
  'projects.update': channel(
    UpdateProjectInputSchema,
    ProjectSchema,
    'Rename / describe a project.',
  ),
  'projects.archive': channel(
    ProjectRefInputSchema,
    ProjectSchema,
    'Archive (soft-delete) a project.',
  ),
  /** Opens the native folder picker in main; the renderer never browses the filesystem. */
  'projects.pickDirectory': channel(
    Empty,
    AbsolutePathSchema.nullable(),
    'Native directory picker.',
  ),

  'providers.listAdapters': channel(Empty, z.array(AdapterDescriptorSchema), 'Known adapters.'),
  'providers.checkDependencies': channel(
    z.object({ adapterKey: AdapterKeySchema }),
    DependencyReportSchema,
    'Verify that an adapter dependency (CLI, server) is installed and usable.',
  ),
  'providers.getCapabilities': channel(
    z.object({ adapterKey: AdapterKeySchema }),
    AgentCapabilitiesSchema,
    'Verified capabilities of an adapter.',
  ),

  'sessions.start': channel(StartSessionInputSchema, AgentSessionSchema, 'Start an agent session.'),
  'sessions.stop': channel(SessionRefInputSchema, AgentSessionSchema, 'End an agent session.'),
  'sessions.listByProject': channel(
    z.object({ projectId: ProjectIdSchema }),
    z.array(AgentSessionSchema),
    'Sessions of a project.',
  ),

  'executions.submit': channel(
    SubmitExecutionInputSchema,
    ExecutionHandleSchema,
    'Send an instruction.',
  ),
  'executions.interrupt': channel(InterruptInputSchema, ExecutionHandleSchema, 'Interrupt / kill.'),
  'executions.getResult': channel(
    ExecutionRefInputSchema,
    ExecutionResultSchema.nullable(),
    'Final result.',
  ),
  'executions.listEvents': channel(
    ListExecutionEventsInputSchema,
    z.array(ExecutionEventSchema),
    'Persisted event history (replay after reconnect).',
  ),

  'approvals.listPending': channel(Empty, z.array(ApprovalRequestSchema), 'Pending approvals.'),
  'approvals.decide': channel(
    ApprovalDecisionInputSchema,
    ApprovalRequestSchema,
    'Human decision.',
  ),

  'settings.get': channel(Empty, ApplicationSettingsSchema, 'Read settings.'),
  'settings.update': channel(SettingsPatchSchema, ApplicationSettingsSchema, 'Patch settings.'),

  'audit.list': channel(
    z.object({
      projectId: ProjectIdSchema.optional(),
      limit: z.number().int().min(1).max(1000).default(200),
    }),
    z.array(AuditEventSchema),
    'Read the audit log (read-only; it cannot be disabled from the renderer).',
  ),

  // ---- 0.2.0: core block ---------------------------------------------------
  'projects.create': channel(
    C.CreateProjectInputSchema,
    ProjectSchema,
    'Create a new folder and register it.',
  ),
  'projects.remove': channel(
    C.RemoveProjectInputSchema,
    z.object({ removed: z.literal(true) }),
    'Remove the registration and its history. Files on disk are NOT deleted.',
  ),
  'projects.restore': channel(ProjectRefInputSchema, ProjectSchema, 'Un-archive a project.'),
  'projects.listRecent': channel(
    C.RecentProjectsInputSchema,
    z.array(ProjectSchema),
    'Recently opened.',
  ),
  'projects.markOpened': channel(
    ProjectRefInputSchema,
    ProjectSchema,
    'Record that a project was opened.',
  ),
  'projects.detectTechnologies': channel(
    ProjectRefInputSchema,
    ProjectSchema,
    'Re-scan manifest files.',
  ),
  'projects.getSettings': channel(
    ProjectRefInputSchema,
    C.ProjectSettingsSchema,
    'Per-project settings.',
  ),
  'projects.updateSettings': channel(
    C.ProjectSettingsPatchSchema,
    C.ProjectSettingsSchema,
    'Patch.',
  ),
  'projects.export': channel(
    ProjectRefInputSchema,
    C.BackupResultSchema.nullable(),
    'Export project data (JSON, no secrets) via save dialog.',
  ),
  'workspaces.list': channel(
    z.object({ projectId: ProjectIdSchema }),
    z.array(WorkspaceSchema),
    'Workspaces.',
  ),
  'workspaces.updateAccess': channel(
    C.UpdateWorkspaceAccessInputSchema,
    WorkspaceSchema,
    'Authorized directories.',
  ),

  'providers.listConfigured': channel(
    Empty,
    z.array(C.ProviderProfileSchema),
    'Configured providers with evidence-based readiness.',
  ),
  'providers.get': channel(
    z.object({ id: ProviderIdSchema }),
    C.ProviderProfileSchema,
    'One provider.',
  ),
  'providers.register': channel(
    C.RegisterProviderInputSchema,
    C.ProviderProfileSchema,
    'Add provider configuration.',
  ),
  'providers.update': channel(
    C.UpdateProviderInputSchema,
    C.ProviderProfileSchema,
    'Edit configuration.',
  ),
  'providers.setEnabled': channel(
    C.SetProviderEnabledInputSchema,
    C.ProviderProfileSchema,
    'Enable / disable.',
  ),
  'providers.remove': channel(
    z.object({ id: ProviderIdSchema }),
    z.object({ removed: z.literal(true) }),
    'Remove (fails if agents use it).',
  ),

  'agents.list': channel(Empty, z.array(AgentSchema), 'Known agents.'),
  'agents.register': channel(C.RegisterAgentInputSchema, AgentSchema, 'Add an agent.'),
  'agents.update': channel(C.UpdateAgentInputSchema, AgentSchema, 'Edit an agent.'),

  'credentials.list': channel(
    Empty,
    z.array(CredentialReferenceSchema),
    'References only — never values.',
  ),
  'credentials.store': channel(
    C.StoreCredentialInputSchema,
    CredentialReferenceSchema,
    'Store a secret (encrypted by the OS).',
  ),
  'credentials.remove': channel(
    C.CredentialRefInputSchema,
    z.object({ removed: z.literal(true) }),
    'Delete a secret.',
  ),

  'sessions.get': channel(SessionRefInputSchema, AgentSessionSchema, 'One session.'),
  'sessions.list': channel(
    C.ListSessionsInputSchema,
    z.array(AgentSessionSchema),
    'Sessions, filterable by status.',
  ),
  'sessions.history': channel(
    SessionRefInputSchema,
    C.SessionHistorySchema,
    'Instructions, results, files, checkpoints.',
  ),
  'checkpoints.get': channel(C.CheckpointRefInputSchema, CheckpointSchema, 'One checkpoint.'),

  'permissions.listPolicies': channel(Empty, z.array(PermissionPolicySchema), 'Policies.'),
  'permissions.savePolicy': channel(
    PermissionPolicySchema,
    PermissionPolicySchema,
    'Create/replace a policy (version bumps).',
  ),
  'permissions.listGrants': channel(
    C.ListGrantsInputSchema,
    z.array(C.PermissionGrantSchema),
    'Active (or all) grants.',
  ),
  'permissions.revokeGrant': channel(
    C.RevokeGrantInputSchema,
    C.PermissionGrantSchema,
    'Revoke a grant.',
  ),
  'permissions.evaluate': channel(
    C.EvaluatePermissionInputSchema,
    C.PermissionVerdictSchema,
    'Dry-run a permission check.',
  ),

  'usage.summary': channel(C.UsageSummaryInputSchema, C.UsageSummarySchema, 'Consumption.'),

  'system.storageHealth': channel(
    Empty,
    C.StorageHealthSchema,
    'Database integrity and recovery report.',
  ),
  'system.backup': channel(Empty, C.BackupResultSchema, 'Create a local database backup now.'),
} as const satisfies Record<string, ChannelDefinition>;

export type IpcChannelKey = keyof typeof IPC_CHANNELS;
export type IpcInput<K extends IpcChannelKey> = z.input<(typeof IPC_CHANNELS)[K]['request']>;
export type IpcParsedInput<K extends IpcChannelKey> = z.output<(typeof IPC_CHANNELS)[K]['request']>;
export type IpcOutput<K extends IpcChannelKey> = z.output<(typeof IPC_CHANNELS)[K]['response']>;

/** Main -> renderer push events. */
export const IPC_EVENTS = {
  'execution.event': ExecutionEventSchema,
  'approval.requested': ApprovalRequestSchema,
  'projects.changed': z.object({ projectId: ProjectIdSchema }),
  /** @since 0.2.0 */
  'approval.decided': ApprovalRequestSchema,
  /** @since 0.2.0 */
  'sessions.changed': AgentSessionSchema,
  /** @since 0.2.0 */
  'providers.changed': z.object({ providerId: ProviderIdSchema }),
} as const satisfies Record<string, z.ZodType>;

export type IpcEventKey = keyof typeof IPC_EVENTS;
export type IpcEventPayload<K extends IpcEventKey> = z.output<(typeof IPC_EVENTS)[K]>;

export const IPC_PREFIX = `devbrain:v${IPC_PROTOCOL_VERSION}:` as const;
export const ipcChannelName = (key: IpcChannelKey): string => `${IPC_PREFIX}${key}`;
export const ipcEventName = (key: IpcEventKey): string => `${IPC_PREFIX}event:${key}`;
export const isIpcChannelKey = (value: unknown): value is IpcChannelKey =>
  typeof value === 'string' && Object.hasOwn(IPC_CHANNELS, value);
export const isIpcEventKey = (value: unknown): value is IpcEventKey =>
  typeof value === 'string' && Object.hasOwn(IPC_EVENTS, value);

/** Wire envelope sent by the preload. */
export const IpcRequestEnvelopeSchema = z.object({
  contractsVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  correlationId: z.string().min(8).max(100),
  payload: z.unknown(),
});
export type IpcRequestEnvelope = z.infer<typeof IpcRequestEnvelopeSchema>;

export type IpcResponse<T> =
  | { ok: true; data: T; correlationId: string }
  | { ok: false; error: DevBrainErrorPayload; correlationId: string };

export const IpcResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown(), correlationId: z.string() }),
  z.object({ ok: z.literal(false), error: DevBrainErrorSchema, correlationId: z.string() }),
]);

const major = (version: string): number => Number.parseInt(version.split('.')[0] ?? '', 10);

/** Same major = compatible. 0.x is treated as major 0 (pre-1.0, coordinated via ADR). */
export const isContractsVersionCompatible = (clientVersion: string): boolean =>
  major(clientVersion) === major(CONTRACTS_VERSION);

export type IpcHandler<K extends IpcChannelKey> = (
  input: IpcParsedInput<K>,
  context: { correlationId: string },
) => Promise<IpcOutput<K>> | IpcOutput<K>;

export type IpcHandlerMap = { [K in IpcChannelKey]?: IpcHandler<K> };

/**
 * Validates and dispatches one IPC call. Electron-agnostic so it can be unit tested;
 * apps/desktop wires it into `ipcMain.handle` after checking the sender frame.
 */
export const dispatchIpc = async <K extends IpcChannelKey>(
  key: K,
  rawEnvelope: unknown,
  handler: IpcHandler<K> | undefined,
): Promise<IpcResponse<IpcOutput<K>>> => {
  const envelope = IpcRequestEnvelopeSchema.safeParse(rawEnvelope);
  const fallbackId = 'invalid-envelope';
  if (!envelope.success) {
    return {
      ok: false,
      correlationId: fallbackId,
      error: { code: 'VALIDATION_FAILED', message: 'Malformed IPC envelope', retryable: false },
    };
  }
  const { correlationId, contractsVersion, payload } = envelope.data;
  try {
    if (!isContractsVersionCompatible(contractsVersion)) {
      throw new DevBrainError(
        'CONTRACT_VERSION_MISMATCH',
        `Renderer contracts ${contractsVersion} incompatible with main ${CONTRACTS_VERSION}`,
      );
    }
    if (!handler) throw new DevBrainError('UNSUPPORTED', `Channel not implemented: ${key}`);
    const definition = IPC_CHANNELS[key];
    const input = definition.request.safeParse(payload);
    if (!input.success) {
      throw new DevBrainError('VALIDATION_FAILED', 'Invalid request payload', {
        details: {
          issues: input.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
        },
      });
    }
    const output = await handler(input.data as IpcParsedInput<K>, { correlationId });
    const checked = definition.response.safeParse(output);
    if (!checked.success) {
      throw new DevBrainError('INTERNAL', `Handler for ${key} returned an invalid response`);
    }
    return { ok: true, data: checked.data as IpcOutput<K>, correlationId };
  } catch (error) {
    return { ok: false, error: toErrorPayload(error, correlationId), correlationId };
  }
};

/** API exposed on `window.devbrain` by the preload script. Nothing else is exposed. */
export interface DevBrainBridge {
  readonly contractsVersion: string;
  invoke<K extends IpcChannelKey>(key: K, input: IpcInput<K>): Promise<IpcResponse<IpcOutput<K>>>;
  subscribe<E extends IpcEventKey>(
    event: E,
    listener: (payload: IpcEventPayload<E>) => void,
  ): () => void;
}
