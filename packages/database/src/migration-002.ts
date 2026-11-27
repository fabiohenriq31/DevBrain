/**
 * Migration 2 — Phase 01 core block.
 *
 * - Rebuilds session/execution/event/checkpoint tables with real foreign keys
 *   (ON DELETE CASCADE from projects so "remove registration" is atomic).
 * - Adds project settings, technologies, recents; provider config/health; credential
 *   ciphertext; session files; permission grants; usage ledger; app runs (crash detection).
 * - Replaces the absolute audit DELETE ban with a guarded one (retention pruning only).
 *
 * Never edit after release: add migration 3 instead.
 */
export const MIGRATION_002 = `
PRAGMA defer_foreign_keys = ON;

-- ---------------------------------------------------------------- projects
ALTER TABLE projects ADD COLUMN technologies TEXT NOT NULL DEFAULT '[]';
ALTER TABLE projects ADD COLUMN last_opened_at TEXT;
CREATE INDEX idx_projects_last_opened ON projects(last_opened_at);

CREATE TABLE project_settings (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- providers
ALTER TABLE providers ADD COLUMN config TEXT NOT NULL DEFAULT '{}';
ALTER TABLE providers ADD COLUMN health TEXT NOT NULL DEFAULT '{}';
ALTER TABLE providers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
CREATE INDEX idx_providers_adapter ON providers(adapter_key);

CREATE INDEX idx_agents_provider ON agents(provider_id);

-- ---------------------------------------------------------------- credentials
CREATE TABLE credential_secrets (
  locator TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- rebuild with FKs
DROP INDEX IF EXISTS idx_sessions_project;
DROP INDEX IF EXISTS idx_executions_session;
DROP INDEX IF EXISTS idx_checkpoints_session;
ALTER TABLE agent_sessions RENAME TO agent_sessions_v1;
ALTER TABLE executions RENAME TO executions_v1;
ALTER TABLE execution_events RENAME TO execution_events_v1;
ALTER TABLE checkpoints RENAME TO checkpoints_v1;

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  instance_id TEXT,
  resumed_from_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL,
  data TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_project ON agent_sessions(project_id, started_at);
CREATE INDEX idx_sessions_status ON agent_sessions(status);
CREATE INDEX idx_sessions_agent ON agent_sessions(agent_id);

INSERT INTO agent_sessions (id, agent_id, project_id, workspace_id, status, instance_id,
    resumed_from_session_id, data, started_at, ended_at, updated_at)
  SELECT s.id, s.agent_id, s.project_id, s.workspace_id, s.status, NULL, NULL, s.data,
    s.started_at, s.ended_at, s.started_at
  FROM agent_sessions_v1 s
  WHERE s.agent_id IN (SELECT id FROM agents);

CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  request TEXT NOT NULL,
  result TEXT,
  status TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  event_count INTEGER NOT NULL DEFAULT 0,
  next_seq INTEGER NOT NULL DEFAULT 0,
  stored_output_bytes INTEGER NOT NULL DEFAULT 0,
  output_truncated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_executions_session ON executions(session_id, created_at);
CREATE INDEX idx_executions_status ON executions(status);

INSERT INTO executions (id, session_id, request, result, status, idempotency_key, created_at, finished_at)
  SELECT e.id, e.session_id, e.request, e.result, e.status, e.idempotency_key, e.created_at, e.finished_at
  FROM executions_v1 e
  WHERE e.session_id IN (SELECT id FROM agent_sessions);

CREATE TABLE execution_events (
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  PRIMARY KEY (execution_id, seq)
);
CREATE INDEX idx_events_timestamp ON execution_events(timestamp);

INSERT INTO execution_events (execution_id, seq, id, type, data, timestamp)
  SELECT v.execution_id, v.seq, v.id, v.type, v.data, v.timestamp
  FROM execution_events_v1 v
  WHERE v.execution_id IN (SELECT id FROM executions);

UPDATE executions SET
  event_count = (SELECT COUNT(*) FROM execution_events ev WHERE ev.execution_id = executions.id),
  next_seq = COALESCE((SELECT MAX(seq) + 1 FROM execution_events ev WHERE ev.execution_id = executions.id), 0);

CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES agent_sessions(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_checkpoints_session ON checkpoints(session_id, created_at);
CREATE INDEX idx_checkpoints_project ON checkpoints(project_id, created_at);

INSERT INTO checkpoints (id, project_id, session_id, data, created_at)
  SELECT c.id, c.project_id,
    CASE WHEN c.session_id IN (SELECT id FROM agent_sessions) THEN c.session_id ELSE NULL END,
    c.data, c.created_at
  FROM checkpoints_v1 c
  WHERE c.project_id IN (SELECT id FROM projects);

DROP TABLE execution_events_v1;
DROP TABLE executions_v1;
DROP TABLE checkpoints_v1;
DROP TABLE agent_sessions_v1;

-- ---------------------------------------------------------------- session files
CREATE TABLE session_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  execution_id TEXT REFERENCES executions(id) ON DELETE SET NULL,
  path TEXT NOT NULL,
  change TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX idx_session_files_session ON session_files(session_id, path);

-- ---------------------------------------------------------------- approvals & grants
ALTER TABLE approvals ADD COLUMN agent_id TEXT;
ALTER TABLE approvals ADD COLUMN session_id TEXT;
ALTER TABLE approvals ADD COLUMN project_id TEXT;
CREATE INDEX idx_approvals_expires ON approvals(status, expires_at);

CREATE TABLE permission_grants (
  id TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES agent_sessions(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('session', 'project')),
  target TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_reason TEXT
);
CREATE INDEX idx_grants_lookup ON permission_grants(agent_id, action, revoked_at, expires_at);

-- ---------------------------------------------------------------- usage
CREATE TABLE usage_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  provider_id TEXT,
  project_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_amount REAL,
  cost_currency TEXT,
  recorded_at TEXT NOT NULL
);
CREATE INDEX idx_usage_time ON usage_records(recorded_at);
CREATE INDEX idx_usage_agent ON usage_records(agent_id, recorded_at);
CREATE INDEX idx_usage_project ON usage_records(project_id, recorded_at);

-- ---------------------------------------------------------------- crash detection
CREATE TABLE app_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  clean_shutdown INTEGER NOT NULL DEFAULT 0,
  app_version TEXT
);

CREATE TABLE maintenance_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------- audit retention
CREATE TABLE audit_guard (id INTEGER PRIMARY KEY CHECK (id = 1), allow_prune INTEGER NOT NULL);
INSERT INTO audit_guard (id, allow_prune) VALUES (1, 0);
DROP TRIGGER audit_no_delete;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events
  WHEN (SELECT allow_prune FROM audit_guard WHERE id = 1) = 0
  BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
CREATE INDEX idx_audit_timestamp ON audit_events(timestamp);
`;
