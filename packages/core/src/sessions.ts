import path from 'node:path';
import {
  CHECKPOINT_STATE_VERSION,
  DevBrainError,
  ExecutionEventSchema,
  ExecutionRequestSchema,
  ExecutionResultSchema,
  ListSessionsInputSchema,
  SaveCheckpointInputSchema,
  StartSessionInputSchema,
  isLiveSession,
  isTerminalStatus,
  newId,
  nowTimestamp,
  parseOrThrow,
  type AgentSession,
  type Checkpoint,
  type ExecutionEvent,
  type ExecutionRecord,
  type ExecutionRequest,
  type ExecutionRequestInput,
  type ExecutionResult,
  type ListSessionsInput,
  type SaveCheckpointInput,
  type SessionHistory,
  type SessionService,
  type SessionStatus,
  type StartSessionInput,
} from '@devbrain/contracts';
import type { AppendEventOutcome } from '@devbrain/database';
import {
  checkWorkspaceAccess,
  redactString,
  toPortableRelative,
  isWithinRoot,
} from '@devbrain/security';
import type { ApprovalService } from './approvals.js';
import { audit, type CoreContext } from './context.js';

type EndStatus = Extract<SessionStatus, 'completed' | 'cancelled' | 'failed' | 'interrupted'>;

/**
 * Session lifecycle and history (persistence side). Running agent processes belongs to the
 * execution engine, which reports instructions, events and results here. Sessions are owned
 * by the app instance that created them; after a crash they are marked `interrupted` and are
 * never "resumed" — a new session may be started from the last checkpoint instead.
 */
export class SessionManager implements SessionService {
  constructor(
    private readonly ctx: CoreContext,
    private readonly approvals: ApprovalService,
  ) {}

  private require(id: string): AgentSession {
    const session = this.ctx.db.sessions.findById(id);
    if (!session) throw new DevBrainError('NOT_FOUND', 'Session not found', { details: { id } });
    return session;
  }

  private requireLive(id: string): AgentSession {
    const session = this.require(id);
    if (!isLiveSession(session.status)) {
      throw new DevBrainError('CONFLICT', `Session is ${session.status}`, {
        details: { status: session.status },
      });
    }
    if (this.ctx.db.sessions.instanceOf(id) !== this.ctx.instanceId) {
      throw new DevBrainError('CONFLICT', 'Session belongs to another app instance');
    }
    return session;
  }

  private changed(session: AgentSession): AgentSession {
    this.ctx.events.emit('sessions.changed', session);
    return session;
  }

  async get(id: string): Promise<AgentSession> {
    return this.require(id);
  }

  async list(input: ListSessionsInput): Promise<AgentSession[]> {
    const parsed = parseOrThrow(ListSessionsInputSchema, input);
    return this.ctx.db.sessions.list({
      projectId: parsed.projectId,
      limit: parsed.limit,
      ...(parsed.status ? { status: parsed.status } : {}),
    });
  }

  async listByProject(projectId: string): Promise<AgentSession[]> {
    return this.list({ projectId });
  }

  /** Creates the session record (no process is started here). */
  async start(input: StartSessionInput): Promise<AgentSession> {
    const parsed = parseOrThrow(StartSessionInputSchema, input);
    const agent = this.ctx.db.agents.findById(parsed.agentId);
    if (!agent) throw new DevBrainError('NOT_FOUND', 'Agent not found');
    if (agent.status === 'disabled')
      throw new DevBrainError('PERMISSION_DENIED', 'Agent is disabled');
    const provider = this.ctx.db.providers.findById(agent.providerId);
    if (!provider?.provider.enabled)
      throw new DevBrainError('PROVIDER_UNAVAILABLE', 'Provider is disabled');
    const project = this.ctx.db.projects.findById(parsed.projectId);
    if (!project) throw new DevBrainError('NOT_FOUND', 'Project not found');
    if (project.archivedAt) throw new DevBrainError('CONFLICT', 'Project is archived');
    const workspace = this.ctx.db.workspaces.findById(parsed.workspaceId);
    if (!workspace || workspace.projectId !== project.id) {
      throw new DevBrainError('VALIDATION_FAILED', 'Workspace does not belong to the project');
    }

    let lastCheckpointId: string | null = null;
    let resumedFromSessionId: string | null = null;
    if (parsed.resumeFromSessionId) {
      const previous = this.require(parsed.resumeFromSessionId);
      if (previous.projectId !== project.id) {
        throw new DevBrainError('VALIDATION_FAILED', 'Previous session belongs to another project');
      }
      if (isLiveSession(previous.status)) {
        throw new DevBrainError('CONFLICT', 'Previous session is still live');
      }
      resumedFromSessionId = previous.id;
      lastCheckpointId = previous.lastCheckpointId;
    }
    if (parsed.resumeFromCheckpointId) {
      const checkpoint = await this.ctx.db.checkpoints.get(parsed.resumeFromCheckpointId);
      if (!checkpoint || checkpoint.projectId !== project.id) {
        throw new DevBrainError('VALIDATION_FAILED', 'Checkpoint does not belong to the project');
      }
      lastCheckpointId = checkpoint.id;
    }

    const now = nowTimestamp();
    const session: AgentSession = {
      id: newId('session'),
      agentId: agent.id,
      projectId: project.id,
      workspaceId: workspace.id,
      status: 'active',
      externalSessionId: null,
      lastCheckpointId,
      startedAt: now,
      endedAt: null,
      title: parsed.title ?? null,
      endReason: null,
      resumedFromSessionId,
      updatedAt: now,
    };
    this.ctx.db.driver.transaction(() => {
      this.ctx.db.sessions.insert(session, this.ctx.instanceId);
      audit(this.ctx, {
        action: 'session.started',
        projectId: project.id,
        target: session.id,
        details: {
          agentId: agent.id,
          workspaceId: workspace.id,
          resumedFromSessionId,
          lastCheckpointId,
        },
      });
    });
    return this.changed(session);
  }

  /** Live-state change (`active` ⇄ `idle`). */
  async setActivity(sessionId: string, status: 'active' | 'idle'): Promise<AgentSession> {
    const session = this.requireLive(sessionId);
    if (session.status === status) return session;
    const next = { ...session, status, updatedAt: nowTimestamp() };
    this.ctx.db.sessions.update(next);
    return this.changed(next);
  }

  /** Provider resume handle (only stored; resumption is the provider's capability). */
  async setExternalSessionId(
    sessionId: string,
    externalSessionId: string | null,
  ): Promise<AgentSession> {
    const session = this.requireLive(sessionId);
    const next = { ...session, externalSessionId, updatedAt: nowTimestamp() };
    this.ctx.db.sessions.update(next);
    return this.changed(next);
  }

  /**
   * Ends a session. Refuses while executions are unfinished (the execution engine must
   * interrupt them first). Session-scoped grants are revoked and pending approvals cancelled.
   */
  async end(sessionId: string, status: EndStatus, reason?: string): Promise<AgentSession> {
    const session = this.require(sessionId);
    if (!isLiveSession(session.status)) {
      if (session.status === status) return session;
      throw new DevBrainError('CONFLICT', `Session is already ${session.status}`);
    }
    if (status !== 'interrupted') {
      const unfinished = this.ctx.db.executions
        .listBySession(sessionId)
        .filter((e) => !isTerminalStatus(e.status));
      if (unfinished.length > 0) {
        throw new DevBrainError(
          'CONFLICT',
          'Interrupt the running executions before ending the session',
          {
            details: { executions: unfinished.map((e) => e.request.id) },
          },
        );
      }
    }
    const now = nowTimestamp();
    const next: AgentSession = {
      ...session,
      status,
      endedAt: now,
      updatedAt: now,
      endReason: reason ? redactString(reason).slice(0, 2000) : null,
    };
    this.ctx.db.driver.transaction(() => {
      this.ctx.db.sessions.update(next);
      const revoked = this.ctx.db.grants.revokeForSession(sessionId, `session ${status}`, now);
      audit(this.ctx, {
        action: `session.${status}`,
        projectId: session.projectId,
        target: sessionId,
        outcome: status === 'failed' ? 'failure' : 'success',
        details: { reason: next.endReason, grantsRevoked: revoked },
      });
    });
    this.approvals.cancelPending({ sessionId }, `session ${status}`);
    return this.changed(next);
  }

  /** User "stop": ends normally. */
  async stop(sessionId: string): Promise<AgentSession> {
    return this.end(sessionId, 'completed', 'stopped by user');
  }

  // ---- history -------------------------------------------------------------

  /**
   * Records an instruction (execution request). Idempotent by `idempotencyKey`. The working
   * directory must resolve (real path) inside the session's workspace.
   */
  async recordInstruction(input: ExecutionRequestInput): Promise<ExecutionRequest> {
    const request = parseOrThrow(ExecutionRequestSchema, input);
    if (request.idempotencyKey) {
      const existing = this.ctx.db.executions.findByIdempotencyKey(request.idempotencyKey);
      if (existing) {
        if (existing.sessionId !== request.sessionId) {
          throw new DevBrainError('CONFLICT', 'Idempotency key already used by another session');
        }
        return existing;
      }
    }
    const session = this.requireLive(request.sessionId);
    const workspace = this.ctx.db.workspaces.findById(session.workspaceId);
    if (!workspace) throw new DevBrainError('NOT_FOUND', 'Workspace not found');
    const access = await checkWorkspaceAccess(workspace.access, request.workingDirectory, 'read');
    if (!access.allowed) {
      throw new DevBrainError(
        'PATH_OUTSIDE_SCOPE',
        `Working directory rejected: ${access.message}`,
      );
    }
    const now = nowTimestamp();
    this.ctx.db.driver.transaction(() => {
      this.ctx.db.executions.appendRequestSync(request);
      if (request.payload.kind === 'prompt') {
        for (const file of request.payload.contextFiles) {
          this.addFile(session, request.id, file, 'referenced', workspace.rootPath, now);
        }
      }
      this.ctx.db.sessions.update({ ...session, status: 'active', updatedAt: now });
      audit(this.ctx, {
        action: 'session.instruction-recorded',
        actor: { type: 'user' },
        projectId: session.projectId,
        target: request.id,
        details: { sessionId: session.id, kind: request.payload.kind },
      });
    });
    return request;
  }

  private addFile(
    session: AgentSession,
    executionId: string | null,
    filePath: string,
    change: 'read' | 'created' | 'modified' | 'deleted' | 'renamed' | 'referenced',
    root: string,
    at: string,
  ): void {
    let relative = filePath.replace(/\\/g, '/');
    if (path.isAbsolute(filePath)) {
      // Paths outside the workspace are recorded verbatim-free: only in-scope paths are kept.
      if (!isWithinRoot(root, filePath)) return;
      relative = toPortableRelative(root, filePath);
    }
    if (!relative || relative.startsWith('../')) return;
    this.ctx.db.sessionFiles.add({
      sessionId: session.id,
      executionId,
      path: relative.slice(0, 4096),
      change,
      recordedAt: at,
    });
  }

  /** Persists a streamed event (bounded by retention limits). File changes are indexed. */
  async recordEvent(input: ExecutionEvent): Promise<AppendEventOutcome> {
    const event = parseOrThrow(ExecutionEventSchema, input);
    const session = this.require(event.sessionId);
    return this.ctx.db.driver.transaction(() => {
      const outcome = this.ctx.db.executions.appendEventSync(event);
      if (outcome.stored && event.type === 'file-change') {
        const workspace = this.ctx.db.workspaces.findById(session.workspaceId);
        if (workspace)
          this.addFile(
            session,
            event.executionId,
            event.path,
            event.change,
            workspace.rootPath,
            event.timestamp,
          );
      }
      return outcome;
    });
  }

  /** Final result of an execution; usage is accounted from it (as reported by the provider). */
  async recordResult(input: ExecutionResult): Promise<void> {
    const result = parseOrThrow(ExecutionResultSchema, input);
    const session = this.require(result.sessionId);
    const agent = this.ctx.db.agents.findById(session.agentId);
    this.ctx.db.driver.transaction(() => {
      const existing = this.ctx.db.executions.getRecord(result.executionId);
      if (!existing) throw new DevBrainError('NOT_FOUND', 'Execution not found');
      if (existing.result) throw new DevBrainError('CONFLICT', 'Execution already has a result');
      this.ctx.db.executions.saveResultSync(result);
      if (result.usage) {
        this.ctx.db.usage.record({
          executionId: result.executionId,
          agentId: session.agentId,
          providerId: agent?.providerId ?? null,
          projectId: session.projectId,
          usage: result.usage,
        });
      }
      if (isLiveSession(session.status)) {
        this.ctx.db.sessions.update({ ...session, status: 'idle', updatedAt: nowTimestamp() });
      }
    });
  }

  async saveCheckpoint(input: SaveCheckpointInput): Promise<Checkpoint> {
    const parsed = parseOrThrow(SaveCheckpointInputSchema, input);
    const session = this.require(parsed.sessionId);
    const checkpoint: Checkpoint = {
      id: newId('checkpoint'),
      projectId: session.projectId,
      workspaceId: session.workspaceId,
      sessionId: session.id,
      label: parsed.label,
      gitCommit: parsed.gitCommit ?? null,
      schemaVersion: CHECKPOINT_STATE_VERSION,
      state: parsed.state as unknown as Record<string, unknown>,
      createdAt: nowTimestamp(),
    };
    this.ctx.db.driver.transaction(() => {
      this.ctx.db.checkpoints.saveSync(checkpoint);
      this.ctx.db.sessions.update({
        ...session,
        lastCheckpointId: checkpoint.id,
        updatedAt: checkpoint.createdAt,
      });
      audit(this.ctx, {
        action: 'checkpoint.saved',
        projectId: session.projectId,
        target: checkpoint.id,
        details: { sessionId: session.id },
      });
    });
    return checkpoint;
  }

  async getCheckpoint(id: string): Promise<Checkpoint> {
    const checkpoint = await this.ctx.db.checkpoints.get(id);
    if (!checkpoint)
      throw new DevBrainError('NOT_FOUND', 'Checkpoint not found', { details: { id } });
    return checkpoint;
  }

  async history(sessionId: string): Promise<SessionHistory> {
    const session = this.require(sessionId);
    return {
      session,
      executions: this.ctx.db.executions.listBySession(sessionId),
      files: this.ctx.db.sessionFiles.listBySession(sessionId),
      checkpoints: this.ctx.db.checkpoints.listBySession(sessionId),
    };
  }

  executionRecord(executionId: string): ExecutionRecord | null {
    return this.ctx.db.executions.getRecord(executionId);
  }
}
