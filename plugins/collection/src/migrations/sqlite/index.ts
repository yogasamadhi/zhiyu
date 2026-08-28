export const collectionSqliteMigration001 = `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  start_url TEXT NOT NULL,
  instruction TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','ready','running','succeeded','failed')),
  schedule TEXT NOT NULL,
  request_settings TEXT NOT NULL,
  browser_settings TEXT NOT NULL,
  pagination TEXT NOT NULL,
  output_settings TEXT NOT NULL,
  credential_bindings TEXT NOT NULL,
  dataset_settings TEXT NOT NULL,
  retention_policy TEXT NOT NULL,
  network_policy TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX collection_tasks_status_idx ON tasks(status,updated_at DESC,id DESC);

CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  active_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX collection_rules_task_idx ON rules(task_id);

CREATE TABLE rule_versions (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  definition TEXT NOT NULL,
  generated_by TEXT NOT NULL CHECK (generated_by IN ('human','ai','system')),
  created_at TEXT NOT NULL,
  UNIQUE(rule_id,version)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','canceled')),
  started_at TEXT,
  finished_at TEXT,
  request_count INTEGER NOT NULL,
  record_count INTEGER NOT NULL,
  browser_used INTEGER NOT NULL CHECK (browser_used IN (0,1)),
  ai_used INTEGER NOT NULL CHECK (ai_used IN (0,1)),
  error TEXT,
  error_code TEXT,
  phase TEXT NOT NULL,
  progress REAL NOT NULL CHECK (progress BETWEEN 0 AND 1),
  cancel_requested_at TEXT,
  dataset_stats TEXT NOT NULL,
  dataset_id TEXT,
  dataset_snapshot_id TEXT,
  delivery_status TEXT NOT NULL,
  warning_count INTEGER NOT NULL,
  metadata TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX collection_runs_task_idx ON runs(task_id,created_at DESC,id DESC);
CREATE UNIQUE INDEX collection_runs_active_uq ON runs(task_id)
WHERE status IN ('queued','running');

CREATE TABLE run_logs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('debug','info','warn','error')),
  phase TEXT NOT NULL,
  message TEXT NOT NULL,
  url TEXT,
  error_code TEXT,
  metadata TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id,sequence)
);

CREATE TABLE run_requests (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('list','pagination','detail','api')),
  status TEXT NOT NULL CHECK (status IN ('succeeded','failed','skipped')),
  status_code INTEGER,
  duration_ms INTEGER NOT NULL,
  error_code TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX collection_run_requests_cursor_idx ON run_requests(run_id,created_at,id);

CREATE TABLE task_schedules (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL,
  misfire_policy TEXT NOT NULL,
  last_triggered_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE rule_repair_proposals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  run_id TEXT,
  definition TEXT NOT NULL,
  explanation TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','applied','rejected')),
  tested_at TEXT,
  created_at TEXT NOT NULL
);
`;
