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

export const collectionSqliteMigration002 = `
ALTER TABLE tasks ADD COLUMN origin TEXT NOT NULL DEFAULT '{"kind":"manual"}';
`;

export const collectionSqliteMigration003 = `
CREATE TABLE collection_drafts (
 id TEXT PRIMARY KEY,
 revision INTEGER NOT NULL,
 content TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX collection_drafts_updated_idx ON collection_drafts(updated_at DESC,id DESC);
`;

export const collectionSqliteMigration004 = `
CREATE TABLE collection_crawl_sessions (
 run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
 fingerprint TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE collection_crawl_batches (
 run_id TEXT NOT NULL REFERENCES collection_crawl_sessions(run_id) ON DELETE CASCADE,
 id TEXT NOT NULL,
 ordinal INTEGER NOT NULL,
 request_id TEXT NOT NULL,
 sequence INTEGER NOT NULL,
 storage_key TEXT NOT NULL,
 checksum TEXT NOT NULL,
 row_count INTEGER NOT NULL,
 PRIMARY KEY(run_id,id),
 UNIQUE(run_id,ordinal)
);
`;

export const collectionSqliteMigration005 = `
ALTER TABLE collection_crawl_sessions ADD COLUMN request_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collection_crawl_sessions ADD COLUMN raw_record_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collection_crawl_sessions ADD COLUMN result_json TEXT;
CREATE TABLE collection_crawl_requests (
 run_id TEXT NOT NULL REFERENCES collection_crawl_sessions(run_id) ON DELETE CASCADE,
 id TEXT NOT NULL,
 ordinal INTEGER NOT NULL,
 url TEXT NOT NULL,
 stage TEXT NOT NULL CHECK (stage IN ('api','http','browser','detail')),
 kind TEXT NOT NULL CHECK (kind IN ('list','pagination','detail','api')),
 status TEXT NOT NULL CHECK (status IN ('pending','completed')),
 reserved_records INTEGER,
 source_url TEXT,
 browser_used INTEGER NOT NULL DEFAULT 0 CHECK (browser_used IN (0,1)),
 next_requests TEXT NOT NULL DEFAULT '[]',
 PRIMARY KEY(run_id,id),
 UNIQUE(run_id,ordinal)
);
CREATE INDEX collection_crawl_requests_stage_idx ON collection_crawl_requests(run_id,stage,ordinal);
`;

export const collectionSqliteMigration006 = `
ALTER TABLE collection_crawl_sessions ADD COLUMN sitemap_node_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collection_crawl_sessions ADD COLUMN sitemap_entry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collection_crawl_sessions ADD COLUMN sitemap_truncated INTEGER NOT NULL DEFAULT 0;
CREATE TABLE collection_crawl_sitemap_nodes (
 run_id TEXT NOT NULL REFERENCES collection_crawl_sessions(run_id) ON DELETE CASCADE,
 id TEXT NOT NULL,
 ordinal INTEGER NOT NULL,
 url TEXT NOT NULL,
 depth INTEGER NOT NULL CHECK (depth BETWEEN 0 AND 3),
 PRIMARY KEY(run_id,id),
 UNIQUE(run_id,ordinal)
);
CREATE TABLE collection_crawl_sitemap_entries (
 run_id TEXT NOT NULL REFERENCES collection_crawl_sessions(run_id) ON DELETE CASCADE,
 url TEXT NOT NULL,
 ordinal INTEGER NOT NULL,
 last_modified TEXT,
 modified INTEGER NOT NULL,
 PRIMARY KEY(run_id,url),
 UNIQUE(run_id,ordinal)
);
CREATE INDEX collection_crawl_sitemap_entries_sort_idx ON collection_crawl_sitemap_entries(run_id,modified DESC,ordinal);
CREATE TABLE collection_crawl_sitemap_batches (
 run_id TEXT NOT NULL REFERENCES collection_crawl_sessions(run_id) ON DELETE CASCADE,
 id TEXT NOT NULL,
 ordinal INTEGER NOT NULL,
 request_id TEXT NOT NULL,
 sequence INTEGER NOT NULL,
 checksum TEXT NOT NULL,
 storage_key TEXT NOT NULL,
 row_count INTEGER NOT NULL,
 PRIMARY KEY(run_id,id),
 UNIQUE(run_id,ordinal),
 UNIQUE(run_id,request_id,sequence)
);
`;

export const collectionSqliteMigration007 = `
CREATE TABLE collection_crawl_cleanup (
 run_id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL,
 reason TEXT NOT NULL CHECK (reason IN ('canceled','deleted','terminal')),
 created_at TEXT NOT NULL,
 available_at TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 error_code TEXT
);
CREATE INDEX collection_crawl_cleanup_due_idx ON collection_crawl_cleanup(available_at,run_id);
`;

export const collectionSqliteMigration008 = `
CREATE TABLE collection_crawl_browser_rounds (
 run_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 round INTEGER NOT NULL CHECK (round BETWEEN 0 AND 100),
 source_url TEXT NOT NULL,
 checksum TEXT NOT NULL,
 observed_records INTEGER NOT NULL,
 available_records INTEGER NOT NULL,
 reserved_records INTEGER NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('pending','completed')),
 state_json TEXT,
 PRIMARY KEY(run_id,request_id,round),
 FOREIGN KEY(run_id,request_id) REFERENCES collection_crawl_requests(run_id,id) ON DELETE CASCADE
);
CREATE TABLE collection_crawl_browser_selected (
 run_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 round INTEGER NOT NULL,
 position INTEGER NOT NULL,
 PRIMARY KEY(run_id,request_id,round,position),
 FOREIGN KEY(run_id,request_id,round) REFERENCES collection_crawl_browser_rounds(run_id,request_id,round) ON DELETE CASCADE
);
CREATE TABLE collection_crawl_browser_observed (
 run_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 round INTEGER NOT NULL,
 record_hash TEXT NOT NULL,
 occurrence_count INTEGER NOT NULL,
 PRIMARY KEY(run_id,request_id,round,record_hash),
 FOREIGN KEY(run_id,request_id,round) REFERENCES collection_crawl_browser_rounds(run_id,request_id,round) ON DELETE CASCADE
);
CREATE TABLE collection_crawl_browser_seen (
 run_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 record_hash TEXT NOT NULL,
 occurrence_count INTEGER NOT NULL,
 PRIMARY KEY(run_id,request_id,record_hash),
 FOREIGN KEY(run_id,request_id) REFERENCES collection_crawl_requests(run_id,id) ON DELETE CASCADE
);
`;
