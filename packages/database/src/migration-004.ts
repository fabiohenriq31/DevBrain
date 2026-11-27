/**
 * Phase 02 intelligence. Policies, privacy facts, routing explanations, cost records and
 * benchmark runs. No prompt, response, credential or file content is stored here.
 */
export const MIGRATION_004 = `
  CREATE TABLE ai_project_policies (
    project_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE ai_privacy_profiles (
    provider_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE ai_routing_decisions (
    request_id TEXT PRIMARY KEY, data TEXT NOT NULL, decided_at TEXT NOT NULL
  );
  CREATE TABLE ai_cost_records (
    request_id TEXT NOT NULL, route_id TEXT NOT NULL, project_id TEXT, session_id TEXT,
    currency TEXT NOT NULL, state TEXT NOT NULL
      CHECK (state IN ('free','estimated','reconciled','reported','unknown')),
    data TEXT NOT NULL, recorded_at TEXT NOT NULL,
    PRIMARY KEY (request_id, route_id)
  );
  CREATE INDEX ai_cost_records_project ON ai_cost_records(project_id, recorded_at);
  CREATE TABLE ai_benchmark_runs (
    id TEXT PRIMARY KEY, suite_id TEXT NOT NULL, suite_version TEXT NOT NULL,
    route_id TEXT NOT NULL, model_id TEXT NOT NULL, data TEXT NOT NULL, finished_at TEXT NOT NULL
  );
  CREATE INDEX ai_benchmark_runs_model ON ai_benchmark_runs(model_id, finished_at);
`;
