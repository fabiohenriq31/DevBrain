import { createHash } from 'node:crypto';
import { DevBrainError } from '@devbrain/contracts';
import type { SqlDriver } from './driver.js';
import { MIGRATION_002 } from './migration-002.js';
import { MIGRATION_003 } from './migration-003.js';

/**
 * Forward-only, append-only migrations. Rules:
 * - Never edit a released migration (checksums are verified at startup).
 * - New tables/columns are added in a new migration.
 * - JSON columns store contract-validated payloads; validate on read.
 */
export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'foundation',
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        root_path_key TEXT NOT NULL UNIQUE,
        description TEXT,
        is_git_repository INTEGER NOT NULL DEFAULT 0,
        default_workspace_id TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT
      );

      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('primary', 'git-worktree')),
        root_path TEXT NOT NULL,
        branch TEXT,
        access TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_workspaces_project ON workspaces(project_id);

      CREATE TABLE providers (
        id TEXT PRIMARY KEY,
        adapter_key TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES providers(id),
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE permission_policies (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id),
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        status TEXT NOT NULL,
        data TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
      CREATE INDEX idx_sessions_project ON agent_sessions(project_id);

      CREATE TABLE executions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        request TEXT NOT NULL,
        result TEXT,
        status TEXT NOT NULL,
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX idx_executions_session ON executions(session_id);

      CREATE TABLE execution_events (
        execution_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        id TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        PRIMARY KEY (execution_id, seq)
      );

      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        data TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX idx_approvals_status ON approvals(status);

      CREATE TABLE credential_refs (
        id TEXT PRIMARY KEY,
        locator TEXT NOT NULL UNIQUE,
        data TEXT NOT NULL
      );

      CREATE TABLE checkpoints (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_checkpoints_session ON checkpoints(session_id, created_at);

      CREATE TABLE audit_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        timestamp TEXT NOT NULL,
        action TEXT NOT NULL,
        project_id TEXT,
        outcome TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX idx_audit_project ON audit_events(project_id, seq);

      -- The audit log is append-only.
      CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events
        BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
      CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events
        BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  { id: 2, name: 'phase-01-core', sql: MIGRATION_002 },
  { id: 3, name: 'phase-02-ai-resources', sql: MIGRATION_003 },
];

const checksum = (sql: string): string =>
  createHash('sha256').update(sql.replace(/\s+/g, ' ').trim()).digest('hex');

export const currentSchemaVersion = (driver: SqlDriver): number => {
  driver.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const row = driver.get<{ v: number | null }>('SELECT MAX(id) AS v FROM schema_migrations');
  return Number(row?.v ?? 0);
};

/** Applies pending migrations, each in its own transaction. Returns applied ids. */
export const migrate = (
  driver: SqlDriver,
  migrations: readonly Migration[] = MIGRATIONS,
): number[] => {
  currentSchemaVersion(driver);
  const applied = driver.all<{ id: number; checksum: string }>(
    'SELECT id, checksum FROM schema_migrations',
  );
  const known = new Map(applied.map((r) => [Number(r.id), String(r.checksum)]));
  const latestKnown = Math.max(0, ...migrations.map((m) => m.id));
  for (const id of known.keys()) {
    if (id > latestKnown) {
      throw new DevBrainError(
        'CONTRACT_VERSION_MISMATCH',
        `Database schema ${id} is newer than this build supports`,
      );
    }
  }
  const done: number[] = [];
  for (const migration of [...migrations].sort((a, b) => a.id - b.id)) {
    const sum = checksum(migration.sql);
    const existing = known.get(migration.id);
    if (existing !== undefined) {
      if (existing !== sum) {
        throw new DevBrainError(
          'INTERNAL',
          `Migration ${migration.id} (${migration.name}) was modified after release`,
        );
      }
      continue;
    }
    driver.transaction(() => {
      driver.exec(migration.sql);
      driver.run(
        'INSERT INTO schema_migrations (id, name, checksum, applied_at) VALUES (:id, :name, :checksum, :at)',
        {
          id: migration.id,
          name: migration.name,
          checksum: sum,
          at: new Date().toISOString(),
        },
      );
    });
    done.push(migration.id);
  }
  return done;
};
