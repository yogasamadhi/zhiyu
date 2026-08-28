export const analyticsPostgresMigration001 = `
CREATE TABLE analysis_recipes (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  dataset_id UUID NOT NULL,
  method_id TEXT NOT NULL,
  method_version TEXT NOT NULL,
  parameters JSONB NOT NULL,
  revision INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX analytics_recipes_cursor_idx ON analysis_recipes(created_at DESC,id DESC);

CREATE TABLE analysis_jobs (
  id UUID PRIMARY KEY,
  recipe_id UUID,
  dataset_id UUID NOT NULL,
  snapshot_id UUID NOT NULL,
  method_id TEXT NOT NULL,
  method_version TEXT NOT NULL,
  parameters JSONB NOT NULL,
  sampling JSONB NOT NULL,
  result_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX analytics_jobs_created_idx ON analysis_jobs(created_at DESC,id DESC);
CREATE INDEX analytics_jobs_snapshot_idx ON analysis_jobs(snapshot_id,method_id,method_version);

CREATE TABLE analysis_results (
  id UUID PRIMARY KEY,
  job_id UUID NOT NULL UNIQUE REFERENCES analysis_jobs(id) ON DELETE CASCADE,
  dataset_id UUID NOT NULL,
  snapshot_id UUID NOT NULL,
  method_id TEXT NOT NULL,
  method_version TEXT NOT NULL,
  summary JSONB NOT NULL,
  metrics JSONB NOT NULL,
  tables_data JSONB NOT NULL,
  series_data JSONB NOT NULL,
  warnings JSONB NOT NULL,
  sampling JSONB NOT NULL,
  worker_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE analysis_artifacts (
  result_id UUID NOT NULL REFERENCES analysis_results(id) ON DELETE CASCADE,
  artifact_id UUID NOT NULL,
  kind TEXT NOT NULL,
  content_type TEXT NOT NULL,
  filename TEXT NOT NULL,
  PRIMARY KEY(result_id,artifact_id)
);
`;
