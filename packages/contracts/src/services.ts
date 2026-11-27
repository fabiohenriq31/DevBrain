import type { AgentSession, StartSessionInput } from './entities/agent.js';
import type {
  ExecutionEvent,
  ExecutionRequest,
  ExecutionResult,
  InterruptInput,
  ListExecutionEventsInput,
} from './entities/execution.js';
import type {
  ApprovalDecisionInput,
  ApprovalRequest,
  PermissionAction,
  PermissionDecision,
} from './entities/permissions.js';
import type {
  ListProjectsInput,
  Project,
  RegisterProjectInput,
  UpdateProjectInput,
  Workspace,
} from './entities/project.js';
import type {
  AdapterDescriptor,
  AgentCapabilities,
  DependencyReport,
} from './entities/provider.js';
import type {
  ApplicationSettings,
  AuditEvent,
  AuditEventInput,
  Checkpoint,
  GitRepository,
  GitStatus,
  SettingsPatch,
} from './entities/records.js';
import type { ExecutionHandle, SubmitExecutionInput } from './ipc.js';

/**
 * Service boundaries implemented in the Electron main process (or a utility process).
 * Implementations throw `DevBrainError`; IPC adapters translate to `IpcResponse`.
 * Owners: see docs/OWNERSHIP.md.
 */

/** Owner: Claude (`@devbrain/project-engine`). */
export interface ProjectService {
  list(input?: ListProjectsInput): Promise<Project[]>;
  get(id: string): Promise<Project>;
  register(input: RegisterProjectInput): Promise<Project>;
  update(input: UpdateProjectInput): Promise<Project>;
  archive(id: string): Promise<Project>;
  listWorkspaces(projectId: string): Promise<Workspace[]>;
}

/** Owner: Codex (`@devbrain/provider-sdk`, `@devbrain/execution-engine`). */
export interface AgentDiscoveryService {
  listAdapters(): Promise<AdapterDescriptor[]>;
  checkDependencies(adapterKey: string): Promise<DependencyReport>;
  getCapabilities(adapterKey: string): Promise<AgentCapabilities>;
}

/** Owner: Codex (`@devbrain/execution-engine`). */
export interface SessionService {
  start(input: StartSessionInput): Promise<AgentSession>;
  stop(sessionId: string): Promise<AgentSession>;
  listByProject(projectId: string): Promise<AgentSession[]>;
}

export type ExecutionEventListener = (event: ExecutionEvent) => void;
export type Unsubscribe = () => void;

/** Owner: Codex (`@devbrain/execution-engine`). */
export interface ExecutionService {
  submit(input: SubmitExecutionInput): Promise<ExecutionHandle>;
  interrupt(input: InterruptInput): Promise<ExecutionHandle>;
  getResult(executionId: string): Promise<ExecutionResult | null>;
  /** Live stream. Persisted history is served by `ExecutionHistoryStore`. */
  subscribe(listener: ExecutionEventListener): Unsubscribe;
}

/** Owner: Claude (`@devbrain/database`). */
export interface ExecutionHistoryStore {
  appendRequest(request: ExecutionRequest): Promise<void>;
  appendEvent(event: ExecutionEvent): Promise<void>;
  saveResult(result: ExecutionResult): Promise<void>;
  listEvents(input: ListExecutionEventsInput): Promise<ExecutionEvent[]>;
  getResult(executionId: string): Promise<ExecutionResult | null>;
}

export interface PermissionCheck {
  agentId: string;
  action: PermissionAction;
  /** Absolute target path, when the action touches the filesystem. */
  path?: string;
  /** Executable name for `process.spawn`. */
  executable?: string;
  /** True if triggered by content from files/tools/agent output. */
  untrustedOrigin?: boolean;
}

export interface PermissionVerdict {
  decision: PermissionDecision;
  reason: string;
}

/** Owner: Claude (`@devbrain/security`). */
export interface PermissionService {
  check(input: PermissionCheck): Promise<PermissionVerdict>;
}

/** Owner: Claude (`@devbrain/security` + `@devbrain/database`); UI by Antigravity. */
export interface ApprovalService {
  request(
    input: Omit<
      ApprovalRequest,
      'id' | 'status' | 'requestedAt' | 'expiresAt' | 'decidedAt' | 'decidedBy' | 'decisionNote'
    >,
  ): Promise<ApprovalRequest>;
  listPending(): Promise<ApprovalRequest[]>;
  /** Must only be reachable from a user action in the renderer — never from an agent. */
  decide(input: ApprovalDecisionInput): Promise<ApprovalRequest>;
  /** Resolves when decided or expired. */
  waitFor(approvalId: string, signal?: AbortSignal): Promise<ApprovalRequest>;
}

/** Owner: Claude (`@devbrain/database`). */
export interface AuditLog {
  append(event: AuditEventInput): Promise<AuditEvent>;
  list(filter: { projectId?: string; limit: number }): Promise<AuditEvent[]>;
}

/** Owner: Claude (`@devbrain/database`). */
export interface SettingsStore {
  get(): Promise<ApplicationSettings>;
  update(patch: SettingsPatch): Promise<ApplicationSettings>;
}

/** Owner: Claude (`@devbrain/database`). */
export interface CheckpointStore {
  save(checkpoint: Checkpoint): Promise<void>;
  latestForSession(sessionId: string): Promise<Checkpoint | null>;
  get(id: string): Promise<Checkpoint | null>;
}

/** Owner: Codex (`@devbrain/git-engine`). */
export interface GitService {
  detect(path: string): Promise<GitRepository | null>;
  status(rootPath: string): Promise<GitStatus>;
  createWorktree(input: {
    repositoryRoot: string;
    path: string;
    branch: string;
    baseRef: string;
  }): Promise<GitRepository>;
  removeWorktree(input: { repositoryRoot: string; path: string }): Promise<void>;
}
