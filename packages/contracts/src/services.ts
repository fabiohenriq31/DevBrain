import type { AgentSession, StartSessionInput } from './entities/agent.js';
import type {
  CreateProjectInput,
  EvaluatePermissionInput,
  ProjectSettings,
  ProjectSettingsPatch,
  RemoveProjectInput,
  UpdateWorkspaceAccessInput,
} from './entities/core.js';
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
  /** @since 0.2.0 */
  create(input: CreateProjectInput): Promise<Project>;
  /** @since 0.2.0 */
  restore(id: string): Promise<Project>;
  /** @since 0.2.0 — removes the registration only; files are never deleted. */
  remove(input: RemoveProjectInput): Promise<void>;
  /** @since 0.2.0 */
  listRecent(limit?: number): Promise<Project[]>;
  /** @since 0.2.0 */
  markOpened(id: string): Promise<Project>;
  /** @since 0.2.0 */
  refreshTechnologies(id: string): Promise<Project>;
  /** @since 0.2.0 */
  getSettings(projectId: string): Promise<ProjectSettings>;
  /** @since 0.2.0 */
  updateSettings(patch: ProjectSettingsPatch): Promise<ProjectSettings>;
  /** @since 0.2.0 */
  updateWorkspaceAccess(input: UpdateWorkspaceAccessInput): Promise<Workspace>;
}

/** Owner: Codex (`@devbrain/provider-sdk`, `@devbrain/execution-engine`). */
export interface AgentDiscoveryService {
  listAdapters(): Promise<AdapterDescriptor[]>;
  checkDependencies(adapterKey: string): Promise<DependencyReport>;
  getCapabilities(adapterKey: string): Promise<AgentCapabilities>;
}

/**
 * Session records and lifecycle: implemented by Claude (`@devbrain/core` SessionManager, 0.2.0).
 * The execution engine (Codex) runs processes on top of it and reports history to it.
 */
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

export interface PermissionVerdict {
  decision: PermissionDecision;
  reason: string;
  /** Grant that lifted an `ask` to `allow`, if any. @since 0.2.0 */
  grantId?: string | null;
}

/**
 * Owner: Claude (`@devbrain/core` AuthorizationService).
 * @since 0.2.0 — replaces the 0.1.0 `check(PermissionCheck)` (INCOMPATIBLE, see
 * docs/INTEGRATION.md): evaluation now requires the workspace so paths are checked against
 * real (link-resolved) authorized directories.
 */
export interface PermissionService {
  /** Dry run. */
  evaluate(input: EvaluatePermissionInput): Promise<PermissionVerdict>;
  /** Evaluate and apply: allow → resolves; deny → throws; ask → approval + wait. */
  enforce(
    input: EvaluatePermissionInput,
    options?: { waitForApproval?: boolean; signal?: AbortSignal; executionId?: string },
  ): Promise<PermissionVerdict>;
}

/** Owner: Claude (`@devbrain/security` + `@devbrain/database`); UI by Antigravity. */
export interface ApprovalService {
  request(
    input: Pick<ApprovalRequest, 'agentId' | 'action' | 'risk' | 'summary' | 'untrustedOrigin'> &
      Partial<
        Pick<ApprovalRequest, 'sessionId' | 'executionId' | 'details' | 'projectId' | 'target'>
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
