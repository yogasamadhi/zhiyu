export const analyticsSqliteMigration001 = `
CREATE TABLE analysis_recipes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  method_id TEXT NOT NULL,
  method_version TEXT NOT NULL,
  parameters TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX analytics_recipes_cursor_idx ON analysis_recipes(created_at DESC,id DESC);

CREATE TABLE analysis_jobs (
  id TEXT PRIMARY KEY,
  recipe_id TEXT,
  dataset_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  method_id TEXT NOT NULL,
  method_version TEXT NOT NULL,
  parameters TEXT NOT NULL,
  sampling TEXT NOT NULL,
  result_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX analytics_jobs_created_idx ON analysis_jobs(created_at DESC,id DESC);
CREATE INDEX analytics_jobs_snapshot_idx ON analysis_jobs(snapshot_id,method_id,method_version);

CREATE TABLE analysis_results (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES analysis_jobs(id) ON DELETE CASCADE,
  dataset_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  method_id TEXT NOT NULL,
  method_version TEXT NOT NULL,
  summary TEXT NOT NULL,
  metrics TEXT NOT NULL,
  tables_data TEXT NOT NULL,
  series_data TEXT NOT NULL,
  warnings TEXT NOT NULL,
  sampling TEXT NOT NULL,
  worker_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE analysis_artifacts (
  result_id TEXT NOT NULL REFERENCES analysis_results(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content_type TEXT NOT NULL,
  filename TEXT NOT NULL,
  PRIMARY KEY(result_id,artifact_id)
);
`;
