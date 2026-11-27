import {
  ApplicationSettingsSchema,
  AuditEventSchema,
  CheckpointSchema,
  DEFAULT_SETTINGS,
  DevBrainError,
  ExecutionEventSchema,
  ExecutionRequestSchema,
  ExecutionResultSchema,
  ListExecutionEventsInputSchema,
  ProjectSchema,
  WorkspaceSchema,
  newId,
  nowTimestamp,
  type ApplicationSettings,
  type AuditEvent,
  type AuditEventInput,
  type AuditLog,
  type Checkpoint,
  type CheckpointStore,
  type ExecutionEvent,
  type ExecutionHistoryStore,
  type ExecutionRequest,
  type ExecutionResult,
  type ListExecutionEventsInput,
  type Project,
  type SettingsPatch,
  type SettingsStore,
  type Workspace,
} from '@devbrain/contracts';
import { redactRecord, redactString } from '@devbrain/security';
import type { SqlDriver, SqlRow } from './driver.js';

const json = (value: unknown): string => JSON.stringify(value);
const parseJson = (value: unknown): unknown => JSON.parse(String(value));

/** Key used for uniqueness of filesystem paths (case-insensitive on Windows/macOS). */
export const pathKey = (p: string, platform: NodeJS.Platform = process.platform): string => {
  const trimmed = p.replace(/[\\/]+$/, '') || p;
  const unified = platform === 'win32' ? trimmed.replace(/\//g, '\\') : trimmed;
  return platform === 'win32' || platform === 'darwin' ? unified.toLowerCase() : unified;
};

// ---------------------------------------------------------------------------

interface ProjectRow extends SqlRow {
  id: string;
  name: string;
  root_path: string;
  description: string | null;
  is_git_repository: number;
  default_workspace_id: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

const toProject = (row: ProjectRow): Project =>
  ProjectSchema.parse({
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    description: row.description,
    isGitRepository: Number(row.is_git_repository) === 1,
    defaultWorkspaceId: row.default_workspace_id,
    metadata: parseJson(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  });

export class ProjectRepository {
  constructor(private readonly db: SqlDriver) {}

  insert(project: Project): Project {
    const valid = ProjectSchema.parse(project);
    try {
      this.db.run(
        `INSERT INTO projects (id, name, root_path, root_path_key, description, is_git_repository,
           default_workspace_id, metadata, created_at, updated_at, archived_at)
         VALUES (:id, :name, :rootPath, :key, :description, :git, :ws, :metadata, :createdAt, :updatedAt, :archivedAt)`,
        {
          id: valid.id,
          name: valid.name,
          rootPath: valid.rootPath,
          key: pathKey(valid.rootPath),
          description: valid.description,
          git: valid.isGitRepository ? 1 : 0,
          ws: valid.defaultWorkspaceId,
          metadata: json(valid.metadata),
          createdAt: valid.createdAt,
          updatedAt: valid.updatedAt,
          archivedAt: valid.archivedAt,
        },
      );
    } catch (error) {
      if (String(error).includes('UNIQUE')) {
        throw new DevBrainError(
          'ALREADY_EXISTS',
          'A project is already registered for this directory',
          {
            details: { rootPath: valid.rootPath },
          },
        );
      }
      throw error;
    }
    return valid;
  }

  update(project: Project): Project {
    const valid = ProjectSchema.parse(project);
    const { changes } = this.db.run(
      `UPDATE projects SET name = :name, description = :description, is_git_repository = :git,
         default_workspace_id = :ws, metadata = :metadata, updated_at = :updatedAt, archived_at = :archivedAt
       WHERE id = :id`,
      {
        id: valid.id,
        name: valid.name,
        description: valid.description,
        git: valid.isGitRepository ? 1 : 0,
        ws: valid.defaultWorkspaceId,
        metadata: json(valid.metadata),
        updatedAt: valid.updatedAt,
        archivedAt: valid.archivedAt,
      },
    );
    if (changes === 0) throw new DevBrainError('NOT_FOUND', 'Project not found');
    return valid;
  }

  findById(id: string): Project | null {
    const row = this.db.get<ProjectRow>('SELECT * FROM projects WHERE id = :id', { id });
    return row ? toProject(row) : null;
  }

  findByRootPath(rootPath: string): Project | null {
    const row = this.db.get<ProjectRow>('SELECT * FROM projects WHERE root_path_key = :key', {
      key: pathKey(rootPath),
    });
    return row ? toProject(row) : null;
  }

  list(includeArchived = false): Project[] {
    const sql = includeArchived
      ? 'SELECT * FROM projects ORDER BY name COLLATE NOCASE'
      : 'SELECT * FROM projects WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE';
    return this.db.all<ProjectRow>(sql).map(toProject);
  }
}

// ---------------------------------------------------------------------------

interface WorkspaceRow extends SqlRow {
  id: string;
  project_id: string;
  name: string;
  kind: string;
  root_path: string;
  branch: string | null;
  access: string;
  created_at: string;
  updated_at: string;
}

const toWorkspace = (row: WorkspaceRow): Workspace =>
  WorkspaceSchema.parse({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    kind: row.kind,
    rootPath: row.root_path,
    branch: row.branch,
    access: parseJson(row.access),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

export class WorkspaceRepository {
  constructor(private readonly db: SqlDriver) {}

  insert(workspace: Workspace): Workspace {
    const w = WorkspaceSchema.parse(workspace);
    this.db.run(
      `INSERT INTO workspaces (id, project_id, name, kind, root_path, branch, access, created_at, updated_at)
       VALUES (:id, :projectId, :name, :kind, :rootPath, :branch, :access, :createdAt, :updatedAt)`,
      {
        id: w.id,
        projectId: w.projectId,
        name: w.name,
        kind: w.kind,
        rootPath: w.rootPath,
        branch: w.branch,
        access: json(w.access),
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
      },
    );
    return w;
  }

  findById(id: string): Workspace | null {
    const row = this.db.get<WorkspaceRow>('SELECT * FROM workspaces WHERE id = :id', { id });
    return row ? toWorkspace(row) : null;
  }

  listByProject(projectId: string): Workspace[] {
    return this.db
      .all<WorkspaceRow>(
        'SELECT * FROM workspaces WHERE project_id = :projectId ORDER BY created_at',
        { projectId },
      )
      .map(toWorkspace);
  }
}

// ---------------------------------------------------------------------------

/** Append-only audit log. Details and targets are redacted before persistence. */
export class SqliteAuditLog implements AuditLog {
  constructor(private readonly db: SqlDriver) {}

  appendSync(input: AuditEventInput): AuditEvent {
    const event = AuditEventSchema.parse({
      ...input,
      id: newId('audit'),
      timestamp: nowTimestamp(),
      target: input.target === null ? null : redactString(input.target),
      details: redactRecord(input.details),
    });
    this.db.run(
      `INSERT INTO audit_events (id, timestamp, action, project_id, outcome, data)
       VALUES (:id, :timestamp, :action, :projectId, :outcome, :data)`,
      {
        id: event.id,
        timestamp: event.timestamp,
        action: event.action,
        projectId: event.projectId,
        outcome: event.outcome,
        data: json(event),
      },
    );
    return event;
  }

  async append(input: AuditEventInput): Promise<AuditEvent> {
    return this.appendSync(input);
  }

  async list(filter: { projectId?: string; limit: number }): Promise<AuditEvent[]> {
    const rows = filter.projectId
      ? this.db.all<{ data: string }>(
          'SELECT data FROM audit_events WHERE project_id = :projectId ORDER BY seq DESC LIMIT :limit',
          { projectId: filter.projectId, limit: filter.limit },
        )
      : this.db.all<{ data: string }>(
          'SELECT data FROM audit_events ORDER BY seq DESC LIMIT :limit',
          {
            limit: filter.limit,
          },
        );
    return rows.map((r) => AuditEventSchema.parse(parseJson(r.data)));
  }
}

// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'application';

export class SqliteSettingsStore implements SettingsStore {
  constructor(private readonly db: SqlDriver) {}

  async get(): Promise<ApplicationSettings> {
    const row = this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = :key', {
      key: SETTINGS_KEY,
    });
    if (!row) return structuredClone(DEFAULT_SETTINGS);
    const parsed = ApplicationSettingsSchema.safeParse(parseJson(row.value));
    // Corrupt or outdated settings fall back to defaults rather than crashing startup.
    return parsed.success ? parsed.data : structuredClone(DEFAULT_SETTINGS);
  }

  async update(patch: SettingsPatch): Promise<ApplicationSettings> {
    const current = await this.get();
    const next = ApplicationSettingsSchema.parse({
      ...current,
      ...(patch.language ? { language: patch.language } : {}),
      ...(patch.theme ? { theme: patch.theme } : {}),
      execution: { ...current.execution, ...patch.execution },
      security: { ...current.security, ...patch.security },
    });
    this.db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (:key, :value, :at)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      { key: SETTINGS_KEY, value: json(next), at: nowTimestamp() },
    );
    return next;
  }
}

// ---------------------------------------------------------------------------

export class SqliteExecutionHistory implements ExecutionHistoryStore {
  constructor(private readonly db: SqlDriver) {}

  async appendRequest(request: ExecutionRequest): Promise<void> {
    const r = ExecutionRequestSchema.parse(request);
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
    return;
  }

  async appendEvent(event: ExecutionEvent): Promise<void> {
    const e = ExecutionEventSchema.parse(event);
    this.db.run(
      `INSERT INTO execution_events (execution_id, seq, id, type, data, timestamp)
       VALUES (:executionId, :seq, :id, :type, :data, :timestamp)`,
      {
        executionId: e.executionId,
        seq: e.seq,
        id: e.id,
        type: e.type,
        data: json(e),
        timestamp: e.timestamp,
      },
    );
    if (e.type === 'status') {
      this.db.run('UPDATE executions SET status = :status WHERE id = :id', {
        status: e.status,
        id: e.executionId,
      });
    }
    return;
  }

  async saveResult(result: ExecutionResult): Promise<void> {
    const r = ExecutionResultSchema.parse(result);
    const { changes } = this.db.run(
      'UPDATE executions SET result = :result, status = :status, finished_at = :finishedAt WHERE id = :id',
      { result: json(r), status: r.status, finishedAt: r.finishedAt, id: r.executionId },
    );
    if (changes === 0) throw new DevBrainError('NOT_FOUND', 'Execution not found');
    return;
  }

  async listEvents(input: ListExecutionEventsInput): Promise<ExecutionEvent[]> {
    const q = ListExecutionEventsInputSchema.parse(input);
    const rows = this.db.all<{ data: string }>(
      `SELECT data FROM execution_events WHERE execution_id = :id AND seq > :afterSeq ORDER BY seq LIMIT :limit`,
      { id: q.executionId, afterSeq: q.afterSeq, limit: q.limit },
    );
    return rows.map((r) => ExecutionEventSchema.parse(parseJson(r.data)));
  }

  async getResult(executionId: string): Promise<ExecutionResult | null> {
    const row = this.db.get<{ result: string | null }>(
      'SELECT result FROM executions WHERE id = :id',
      {
        id: executionId,
      },
    );
    return row?.result ? ExecutionResultSchema.parse(parseJson(row.result)) : null;
  }
}

// ---------------------------------------------------------------------------

export class SqliteCheckpointStore implements CheckpointStore {
  constructor(private readonly db: SqlDriver) {}

  async save(checkpoint: Checkpoint): Promise<void> {
    const c = CheckpointSchema.parse(checkpoint);
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
    return;
  }

  async latestForSession(sessionId: string): Promise<Checkpoint | null> {
    const row = this.db.get<{ data: string }>(
      'SELECT data FROM checkpoints WHERE session_id = :sessionId ORDER BY created_at DESC, rowid DESC LIMIT 1',
      { sessionId },
    );
    return row ? CheckpointSchema.parse(parseJson(row.data)) : null;
  }

  async get(id: string): Promise<Checkpoint | null> {
    const row = this.db.get<{ data: string }>('SELECT data FROM checkpoints WHERE id = :id', {
      id,
    });
    return row ? CheckpointSchema.parse(parseJson(row.data)) : null;
  }
}
