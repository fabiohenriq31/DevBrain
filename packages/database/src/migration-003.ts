/** Phase 02 technical resource ledger. No prompt, response, or credential values are stored. */
export const MIGRATION_003 = `
  CREATE TABLE ai_catalog_snapshots (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL, data TEXT NOT NULL, applied_at TEXT NOT NULL
  );
  CREATE TABLE ai_catalog_entries (
    id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL REFERENCES ai_catalog_snapshots(id),
    data TEXT NOT NULL
  );
  CREATE TABLE ai_connections (
    id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE ai_endpoints (
    id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE ai_models (
    id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE ai_routes (
    id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE ai_routing_policies (
    id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE ai_quota_definitions (
    id TEXT PRIMARY KEY, data TEXT NOT NULL
  );
  CREATE TABLE ai_quota_windows (
    quota_id TEXT NOT NULL REFERENCES ai_quota_definitions(id),
    window_start TEXT NOT NULL, used REAL NOT NULL DEFAULT 0 CHECK (used >= 0),
    reserved REAL NOT NULL DEFAULT 0 CHECK (reserved >= 0),
    PRIMARY KEY (quota_id, window_start)
  );
  CREATE TABLE ai_reservations (
    id TEXT PRIMARY KEY, quota_id TEXT NOT NULL REFERENCES ai_quota_definitions(id),
    request_id TEXT NOT NULL, window_start TEXT NOT NULL, amount REAL NOT NULL CHECK (amount >= 0),
    status TEXT NOT NULL CHECK (status IN ('held','committed','released','expired','uncertain')),
    expires_at TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX ai_reservations_request ON ai_reservations(request_id);
  CREATE TABLE ai_usage (
    id TEXT PRIMARY KEY, request_id TEXT NOT NULL, route_id TEXT NOT NULL,
    data TEXT NOT NULL, recorded_at TEXT NOT NULL
  );
  CREATE INDEX ai_usage_request ON ai_usage(request_id);
  CREATE TABLE ai_inference (
    request_id TEXT PRIMARY KEY, route_id TEXT, model_id TEXT,
    status TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE ai_attempts (
    request_id TEXT NOT NULL, seq INTEGER NOT NULL, route_id TEXT NOT NULL,
    data TEXT NOT NULL, PRIMARY KEY (request_id, seq)
  );
  CREATE TABLE ai_cooldowns (
    route_id TEXT PRIMARY KEY, until_at TEXT NOT NULL, failures INTEGER NOT NULL
  );
`;
