import {
  AgentSessionSchema,
  CheckpointSchema,
  DEFAULT_RETENTION,
  DevBrainError,
  ExecutionEventSchema,
  ExecutionRequestSchema,
  ExecutionResultSchema,
  ListExecutionEventsInputSchema,
  SessionFileSchema,
  TERMINAL_EXECUTION_STATUSES,
  type AgentSession,
  type Checkpoint,
  type CheckpointStore,
  type ExecutionEvent,
  type ExecutionHistoryStore,
  type ExecutionRecord,
  type ExecutionRequest,
  type ExecutionResult,
  type ExecutionStatus,
  type ListExecutionEventsInput,
  type RetentionSettings,
  type SessionFile,
  type SessionStatus,
} from '@devbrain/contracts';
import type { SqlDriver, SqlParams } from '../driver.js';
import { fromJson, json, notFound, validated } from './common.js';

const normalizeSession = (raw: string): AgentSession => {
  const session = fromJson(AgentSessionSchema, raw, 'session');
  // Deprecated statuses (0.1.0) are normalized on read.
  if (session.status === 'ended') return { ...session, status: 'completed' };
  if (session.status === 'suspended') return { ...session, status: 'interrupted' };
  return session;
};

export class SessionRepository {
  constructor(private readonly db: SqlDriver) {}

  insert(session: AgentSession, instanceId: string | null): AgentSession {
    const s = validated(AgentSessionSchema, session, 'session');
    this.db.run(
      `INSERT INTO agent_sessions (id, agent_id, project_id, workspace_id, status, instance_id,
         resumed_from_session_id, data, started_at, ended_at, updated_at)
       VALUES (:id, :agentId, :projectId, :workspaceId, :status, :instanceId, :resumedFrom, :data,
         :startedAt, :endedAt, :updatedAt)`,
      {
        id: s.id,
        agentId: s.agentId,
        projectId: s.projectId,
        workspaceId: s.workspaceId,
        status: s.status,
        instanceId,
        resumedFrom: s.resumedFromSessionId,
        data: json(s),
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        updatedAt: s.updatedAt ?? s.startedAt,
      },
    );
    return s;
  }

  update(session: AgentSession): AgentSession {
    const s = validated(AgentSessionSchema, session, 'session');
    const { changes } = this.db.run(
      `UPDATE agent_sessions SET status = :status, data = :data, ended_at = :endedAt,
         updated_at = :updatedAt WHERE id = :id`,
      {
        id: s.id,
        status: s.status,
        data: json(s),
        endedAt: s.endedAt,
        updatedAt: s.updatedAt ?? new Date().toISOString(),
      },
    );
    if (changes === 0) throw notFound('Session', s.id);
    return s;
  }

  findById(id: string): AgentSession | null {
    const row = this.db.get<{ data: string }>('SELECT data FROM agent_sessions WHERE id = :id', {
      id,
    });
    return row ? normalizeSession(row.data) : null;
  }

  instanceOf(id: string): string | null {
    const row = this.db.get<{ instance_id: string | null }>(
      'SELECT instance_id FROM agent_sessions WHERE id = :id',
      { id },
    );
    return row?.instance_id ?? null;
  }

  list(filter: {
    projectId: string;
    status?: readonly SessionStatus[];
    limit: number;
  }): AgentSession[] {
    const params: SqlParams = { projectId: filter.projectId, limit: filter.limit };
    let where = 'project_id = :projectId';
    if (filter.status?.length) {
      const keys = filter.status.map((s, i) => {
        params[`s${i}`] = s;
        return `:s${i}`;
      });
      where += ` AND status IN (${keys.join(', ')})`;
    }
    return this.db
      .all<{ data: string }>(
        `SELECT data FROM agent_sessions WHERE ${where} ORDER BY started_at DESC LIMIT :limit`,
        params,
      )
      .map((r) => normalizeSession(r.data));
  }

  /** Live sessions not owned by the given app instance (i.e. orphaned by a crash). */
  listOrphaned(currentInstanceId: string): AgentSession[] {
    return this.db
      .all<{ data: string }>(
        `SELECT data FROM agent_sessions
         WHERE status IN ('starting', 'active', 'idle', 'suspended')
           AND (instance_id IS NULL OR instance_id <> :instance)`,
        { instance: currentInstanceId },
      )
      .map((r) => normalizeSession(r.data));
  }
}

// ---------------------------------------------------------------------------

export class SessionFileRepository {
  constructor(private readonly db: SqlDriver) {}

  add(file: SessionFile): SessionFile {
    const f = validated(SessionFileSchema, file, 'session file');
    this.db.run(
      `INSERT INTO session_files (session_id, execution_id, path, change, recorded_at)
       VALUES (:sessionId, :executionId, :path, :change, :recordedAt)`,
      {
        sessionId: f.sessionId,
        executionId: f.executionId,
        path: f.path,
        change: f.change,
        recordedAt: f.recordedAt,
      },
    );
    return f;
  }

  listBySession(sessionId: string, limit = 5000): SessionFile[] {
    return this.db
      .all<{
        session_id: string;
        execution_id: string | null;
        path: string;
        change: string;
        recorded_at: string;
      }>(
        `SELECT session_id, execution_id, path, change, recorded_at FROM session_files
         WHERE session_id = :sessionId ORDER BY id LIMIT :limit`,
        { sessionId, limit },
      )
      .map((r) =>
        validated(
          SessionFileSchema,
          {
            sessionId: r.session_id,
            executionId: r.execution_id,
            path: r.path,
            change: r.change,
            recordedAt: r.recorded_at,
          },
          'stored session file',
        ),
      );
  }
}

// ---------------------------------------------------------------------------

export interface AppendEventOutcome {
  stored: boolean;
  /** True when this event (or part of it) was dropped by retention limits. */
  truncated: boolean;
  /** Duplicate (same execution + seq + id) — idempotent replay, ignored. */
  duplicate: boolean;
}

const ALWAYS_KEEP = new Set<ExecutionEvent['type']>([
  'status',
  'error',
  'approval-required',
  'usage',
]);
const TEXT_BYTES = (e: ExecutionEvent): number =>
  e.type === 'output'
    ? Buffer.byteLength(e.chunk)
    : e.type === 'message'
      ? Buffer.byteLength(e.text)
      : 0;

interface ExecutionRow {
  [k: string]: string | number | null;
  request: string;
  result: string | null;
  status: string;
  event_count: number;
  output_truncated: number;
}

/**
 * Persistent execution history with bounded growth. Output beyond
 * `maxStoredOutputBytesPerExecution` / `maxEventsPerExecution` is dropped and flagged
 * (`outputTruncated`); status, error, approval and usage events are always kept.
 */
export class SqliteExecutionHistory implements ExecutionHistoryStore {
  private limits: RetentionSettings = { ...DEFAULT_RETENTION };

  constructor(private readonly db: SqlDriver) {}

  setLimits(limits: RetentionSettings): void {
    this.limits = { ...limits };
  }

  async appendRequest(request: ExecutionRequest): Promise<void> {
    this.appendRequestSync(request);
  }

  /** Synchronous variant, usable inside a transaction. */
  appendRequestSync(request: ExecutionRequest): void {
    const r = validated(ExecutionRequestSchema, request, 'execution request');
    this.db.run(
      `INSERT INTO executions (id, session_id, request, status, idempotency_key, created_at)
       VALUES (:id, :sessionId, :request, 'queued', :key, :createdAt)`,
      {
        id: r.id,
        sessionId: r.sessionId,
        request: json(r),
        key: r.idempotencyKey,
        createdAt: r.createdAt,
      },
    );
  }

  findByIdempotencyKey(key: string): ExecutionRequest | null {
    const row = this.db.get<{ request: string }>(
      'SELECT request FROM executions WHERE idempotency_key = :key',
      { key },
    );
    return row ? fromJson(ExecutionRequestSchema, row.request, 'execution request') : null;
  }

  async appendEvent(event: ExecutionEvent): Promise<void> {
    this.appendEventSync(event);
  }

  appendEventSync(event: ExecutionEvent): AppendEventOutcome {
    const e = validated(ExecutionEventSchema, event, 'execution event');
    return this.db.transaction(() => {
      const state = this.db.get<{ event_count: number; stored_output_bytes: number }>(
        'SELECT event_count, stored_output_bytes FROM executions WHERE id = :id',
        { id: e.executionId },
      );
      if (!state) throw notFound('Execution', e.executionId);
      const existing = this.db.get<{ id: string }>(
        'SELECT id FROM execution_events WHERE execution_id = :x AND seq = :seq',
        { x: e.executionId, seq: e.seq },
      );
      if (existing) {
        if (existing.id === e.id) return { stored: false, truncated: false, duplicate: true };
        throw new DevBrainError('CONFLICT', 'Another event already uses this sequence number', {
          details: { executionId: e.executionId, seq: e.seq },
        });
      }

      let toStore: ExecutionEvent = e;
      let truncated = false;
      const bytes = TEXT_BYTES(e);
      if (!ALWAYS_KEEP.has(e.type)) {
        const eventsLeft = this.limits.maxEventsPerExecution - Number(state.event_count);
        const bytesLeft =
          this.limits.maxStoredOutputBytesPerExecution - Number(state.stored_output_bytes);
        if (eventsLeft <= 0 || (bytes > 0 && bytesLeft <= 0)) {
          this.db.run('UPDATE executions SET output_truncated = 1 WHERE id = :id', {
            id: e.executionId,
          });
          return { stored: false, truncated: true, duplicate: false };
        }
        if (bytes > bytesLeft) {
          truncated = true;
          const cut = (s: string) => Buffer.from(s).subarray(0, bytesLeft).toString('utf8');
          if (e.type === 'output') toStore = { ...e, chunk: cut(e.chunk) };
          if (e.type === 'message') toStore = { ...e, text: cut(e.text) };
        }
      }
      const storedBytes = TEXT_BYTES(toStore);
      this.db.run(
        `INSERT INTO execution_events (execution_id, seq, id, type, data, timestamp)
         VALUES (:executionId, :seq, :id, :type, :data, :timestamp)`,
        {
          executionId: toStore.executionId,
          seq: toStore.seq,
          id: toStore.id,
          type: toStore.type,
          data: json(toStore),
          timestamp: toStore.timestamp,
        },
      );
      this.db.run(
        `UPDATE executions SET event_count = event_count + 1,
           stored_output_bytes = stored_output_bytes + :bytes,
           next_seq = MAX(next_seq, :next),
           output_truncated = MAX(output_truncated, :trunc),
           status = CASE WHEN :status IS NULL THEN status ELSE :status END
         WHERE id = :id`,
        {
          id: toStore.executionId,
          bytes: storedBytes,
          next: toStore.seq + 1,
          trunc: truncated ? 1 : 0,
          status: toStore.type === 'status' ? toStore.status : null,
        },
      );
      return { stored: true, truncated, duplicate: false };
    });
  }

  async saveResult(result: ExecutionResult): Promise<void> {
    this.saveResultSync(result);
  }

  /** Synchronous variant, usable inside a transaction. */
  saveResultSync(result: ExecutionResult): void {
    const r = validated(ExecutionResultSchema, result, 'execution result');
    const truncatedRow = this.db.get<{ output_truncated: number }>(
      'SELECT output_truncated FROM executions WHERE id = :id',
      { id: r.executionId },
    );
    if (!truncatedRow) throw notFound('Execution', r.executionId);
    const final = {
      ...r,
      outputTruncated: r.outputTruncated || Number(truncatedRow.output_truncated) === 1,
    };
    this.db.run(
      'UPDATE executions SET result = :result, status = :status, finished_at = :finishedAt WHERE id = :id',
      {
        result: json(final),
        status: final.status,
        finishedAt: final.finishedAt,
        id: final.executionId,
      },
    );
  }

  async listEvents(input: ListExecutionEventsInput): Promise<ExecutionEvent[]> {
    const q = ListExecutionEventsInputSchema.parse(input);
    return this.db
      .all<{ data: string }>(
        `SELECT data FROM execution_events WHERE execution_id = :id AND seq > :afterSeq
         ORDER BY seq LIMIT :limit`,
        { id: q.executionId, afterSeq: q.afterSeq, limit: q.limit },
      )
      .map((r) => fromJson(ExecutionEventSchema, r.data, 'execution event'));
  }

  async getResult(executionId: string): Promise<ExecutionResult | null> {
    const row = this.db.get<{ result: string | null }>(
      'SELECT result FROM executions WHERE id = :id',
      {
        id: executionId,
      },
    );
    return row?.result ? fromJson(ExecutionResultSchema, row.result, 'execution result') : null;
  }

  nextSeq(executionId: string): number {
    const row = this.db.get<{ next_seq: number }>(
      'SELECT next_seq FROM executions WHERE id = :id',
      {
        id: executionId,
      },
    );
    if (!row) throw notFound('Execution', executionId);
    return Number(row.next_seq);
  }

  getRecord(executionId: string): ExecutionRecord | null {
    const row = this.db.get<ExecutionRow>(
      'SELECT request, result, status, event_count, output_truncated FROM executions WHERE id = :id',
      { id: executionId },
    );
    return row ? this.toRecord(row) : null;
  }

  listBySession(sessionId: string, limit = 1000): ExecutionRecord[] {
    return this.db
      .all<ExecutionRow>(
        `SELECT request, result, status, event_count, output_truncated FROM executions
         WHERE session_id = :sessionId ORDER BY created_at, rowid LIMIT :limit`,
        { sessionId, limit },
      )
      .map((r) => this.toRecord(r));
  }

  /** Executions not in a terminal status (used by crash recovery). */
  listUnfinished(): ExecutionRequest[] {
    const terminal = [...TERMINAL_EXECUTION_STATUSES].map((s) => `'${s}'`).join(', ');
    return this.db
      .all<{ request: string }>(`SELECT request FROM executions WHERE status NOT IN (${terminal})`)
      .map((r) => fromJson(ExecutionRequestSchema, r.request, 'execution request'));
  }

  private toRecord(row: ExecutionRow): ExecutionRecord {
    return {
      request: fromJson(ExecutionRequestSchema, row.request, 'execution request'),
      status: row.status as ExecutionStatus,
      result: row.result ? fromJson(ExecutionResultSchema, row.result, 'execution result') : null,
      eventCount: Number(row.event_count),
      outputTruncated: Number(row.output_truncated) === 1,
    };
  }
}

// ---------------------------------------------------------------------------

export class SqliteCheckpointStore implements CheckpointStore {
  constructor(private readonly db: SqlDriver) {}

  async save(checkpoint: Checkpoint): Promise<void> {
    this.saveSync(checkpoint);
  }

  /** Synchronous variant, usable inside a transaction. */
  saveSync(checkpoint: Checkpoint): void {
    const c = validated(CheckpointSchema, checkpoint, 'checkpoint');
    this.db.run(
      `INSERT INTO checkpoints (id, project_id, session_id, data, created_at)
       VALUES (:id, :projectId, :sessionId, :data, :createdAt)`,
      {
        id: c.id,
        projectId: c.projectId,
        sessionId: c.sessionId,
        data: json(c),
        createdAt: c.createdAt,
      },
    );
  }

  async latestForSession(sessionId: string): Promise<Checkpoint | null> {
    const row = this.db.get<{ data: string }>(
      'SELECT data FROM checkpoints WHERE session_id = :sessionId ORDER BY created_at DESC, rowid DESC LIMIT 1',
      { sessionId },
    );
    return row ? fromJson(CheckpointSchema, row.data, 'checkpoint') : null;
  }

  async get(id: string): Promise<Checkpoint | null> {
    const row = this.db.get<{ data: string }>('SELECT data FROM checkpoints WHERE id = :id', {
      id,
    });
    return row ? fromJson(CheckpointSchema, row.data, 'checkpoint') : null;
  }

  listBySession(sessionId: string, limit = 200): Checkpoint[] {
    return this.db
      .all<{ data: string }>(
        'SELECT data FROM checkpoints WHERE session_id = :sessionId ORDER BY created_at, rowid LIMIT :limit',
        { sessionId, limit },
      )
      .map((r) => fromJson(CheckpointSchema, r.data, 'checkpoint'));
  }

  listByProject(projectId: string, limit = 1000): Checkpoint[] {
    return this.db
      .all<{ data: string }>(
        'SELECT data FROM checkpoints WHERE project_id = :projectId ORDER BY created_at, rowid LIMIT :limit',
        { projectId, limit },
      )
      .map((r) => fromJson(CheckpointSchema, r.data, 'checkpoint'));
  }
}
