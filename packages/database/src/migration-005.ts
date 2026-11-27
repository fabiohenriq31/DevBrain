/** Provider-observed quota state. Header values are normalized before persistence. */
export const MIGRATION_005 = `
  CREATE TABLE ai_quota_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quota_id TEXT NOT NULL REFERENCES ai_quota_definitions(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    observed_at TEXT NOT NULL
  );
  CREATE INDEX ai_quota_observations_recent ON ai_quota_observations(quota_id, observed_at DESC);
`;
