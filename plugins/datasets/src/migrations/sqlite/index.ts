export const datasetsSqliteMigration001 = `
CREATE TABLE datasets (
  id TEXT PRIMARY KEY,
  source_task_id TEXT NOT NULL UNIQUE,
  settings TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  current_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE records (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  source_run_id TEXT NOT NULL,
  record_key TEXT NOT NULL,
  source_url TEXT NOT NULL,
  data TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(source_run_id,record_key)
);
CREATE INDEX datasets_records_run_idx ON records(source_run_id,created_at,id);

CREATE TABLE dataset_records (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  source_task_id TEXT NOT NULL,
  record_key TEXT NOT NULL,
  source_url TEXT NOT NULL,
  data TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  removed INTEGER NOT NULL CHECK (removed IN (0,1)),
  first_run_id TEXT,
  last_run_id TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(dataset_id,record_key)
);
CREATE INDEX datasets_current_cursor_idx ON dataset_records(dataset_id,removed,last_seen_at DESC,id DESC);

CREATE TABLE record_changes (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  dataset_record_id TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('added','updated','removed')),
  before TEXT,
  after TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX datasets_changes_cursor_idx ON record_changes(dataset_id,created_at DESC,id DESC);

CREATE TABLE dataset_snapshots (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  source_run_id TEXT UNIQUE,
  fingerprint TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  projection_settings TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('projected','preparing','ready','failed')),
  stats TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  parquet_artifact_id TEXT,
  manifest_artifact_id TEXT,
  warnings TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX datasets_snapshots_fingerprint_idx ON dataset_snapshots(dataset_id,fingerprint,status);
`;
