export const recruitmentSqliteMigration001 = `
CREATE TABLE recruitment_sources (
  key TEXT PRIMARY KEY CHECK (key IN ('boss','liepin','huibo')),
  name TEXT NOT NULL,
  official_host TEXT NOT NULL,
  allowed_hosts TEXT NOT NULL,
  terms_url TEXT NOT NULL,
  robots_url TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('import_deeplink','authorized_sync')),
  authorization_status TEXT NOT NULL CHECK (authorization_status IN ('pending','authorized','revoked','error')),
  live_sync_available INTEGER NOT NULL CHECK (live_sync_available IN (0,1)),
  adapter_version TEXT,
  authorization_scope TEXT,
  credential_ref TEXT,
  last_sync_at TEXT,
  last_import_at TEXT,
  last_error TEXT
);

INSERT INTO recruitment_sources(
  key,name,official_host,allowed_hosts,terms_url,robots_url,checked_at,mode,
  authorization_status,live_sync_available,adapter_version,authorization_scope,credential_ref,last_sync_at,last_import_at,last_error
) VALUES
('boss','BOSS 直聘','www.zhipin.com','["www.zhipin.com","zhipin.com","m.zhipin.com"]',
 'https://www.zhipin.com/web/common/protocol/protocol-2019-09-30.html','https://www.zhipin.com/robots.txt',
 '2026-09-01T00:00:00.000Z','import_deeplink','pending',0,NULL,NULL,NULL,NULL,NULL,NULL),
('liepin','猎聘','www.liepin.com','["www.liepin.com","liepin.com","m.liepin.com"]',
 'https://www.liepin.com/','https://www.liepin.com/robots.txt',
 '2026-09-01T00:00:00.000Z','import_deeplink','pending',0,NULL,NULL,NULL,NULL,NULL,NULL),
('huibo','汇博招聘','www.huibo.com','["www.huibo.com","huibo.com","m.huibo.com"]',
 'https://person.huibo.com/register','https://www.huibo.com/robots.txt',
 '2026-09-01T00:00:00.000Z','import_deeplink','pending',0,NULL,NULL,NULL,NULL,NULL,NULL);

CREATE TABLE recruitment_search_profiles (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  last_digest_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE recruitment_source_bindings (
  profile_id TEXT NOT NULL REFERENCES recruitment_search_profiles(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL REFERENCES recruitment_sources(key),
  task_id TEXT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  deep_link TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','ready','degraded')),
  last_run_at TEXT,
  last_import_at TEXT,
  PRIMARY KEY(profile_id,source_key)
);

CREATE TABLE recruitment_import_mappings (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL REFERENCES recruitment_sources(key),
  name TEXT NOT NULL,
  header_fingerprint TEXT NOT NULL,
  fields TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_key,header_fingerprint,name)
);
CREATE INDEX recruitment_mapping_fingerprint_idx
ON recruitment_import_mappings(source_key,header_fingerprint,updated_at DESC);

CREATE TABLE recruitment_import_jobs (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL REFERENCES recruitment_sources(key),
  search_profile_id TEXT NOT NULL REFERENCES recruitment_search_profiles(id) ON DELETE CASCADE,
  mapping_id TEXT REFERENCES recruitment_import_mappings(id) ON DELETE SET NULL,
  mapping_revision INTEGER,
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256)=64),
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  total_rows INTEGER NOT NULL CHECK (total_rows >= 0),
  imported_rows INTEGER NOT NULL DEFAULT 0 CHECK (imported_rows >= 0),
  created_rows INTEGER NOT NULL DEFAULT 0 CHECK (created_rows >= 0),
  updated_rows INTEGER NOT NULL DEFAULT 0 CHECK (updated_rows >= 0),
  unchanged_rows INTEGER NOT NULL DEFAULT 0 CHECK (unchanged_rows >= 0),
  error_rows INTEGER NOT NULL DEFAULT 0 CHECK (error_rows >= 0),
  error_artifact_id TEXT,
  error_summary TEXT NOT NULL DEFAULT '[]',
  errors TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX recruitment_import_jobs_profile_idx
ON recruitment_import_jobs(search_profile_id,started_at DESC);

CREATE TABLE recruitment_postings (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL REFERENCES recruitment_sources(key),
  stable_key TEXT NOT NULL,
  external_id TEXT,
  source_url TEXT,
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT,
  salary_raw TEXT,
  salary_min_monthly INTEGER,
  salary_max_monthly INTEGER,
  salary_months INTEGER,
  description TEXT,
  published_at TEXT,
  expires_at TEXT,
  experience TEXT,
  education TEXT,
  employment_type TEXT,
  skills TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','stale','closed','reopened')),
  normalized_title TEXT NOT NULL,
  normalized_company TEXT NOT NULL,
  normalized_location TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash)=64),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  import_job_id TEXT REFERENCES recruitment_import_jobs(id) ON DELETE SET NULL,
  import_row INTEGER,
  normalizer_version TEXT NOT NULL,
  UNIQUE(source_key,stable_key)
);
CREATE INDEX recruitment_postings_candidate_idx
ON recruitment_postings(normalized_company,normalized_location,published_at);
CREATE INDEX recruitment_postings_status_idx ON recruitment_postings(status,last_seen_at DESC);

CREATE TABLE recruitment_snapshot_presence (
  source_key TEXT NOT NULL REFERENCES recruitment_sources(key),
  profile_id TEXT NOT NULL REFERENCES recruitment_search_profiles(id) ON DELETE CASCADE,
  posting_id TEXT NOT NULL REFERENCES recruitment_postings(id) ON DELETE CASCADE,
  missing_count INTEGER NOT NULL DEFAULT 0 CHECK (missing_count >= 0),
  first_missing_at TEXT,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY(source_key,profile_id,posting_id)
);
CREATE INDEX recruitment_snapshot_presence_posting_idx
ON recruitment_snapshot_presence(posting_id,missing_count);

CREATE TABLE recruitment_posting_changes (
  id TEXT PRIMARY KEY,
  posting_id TEXT NOT NULL REFERENCES recruitment_postings(id) ON DELETE CASCADE,
  import_job_id TEXT REFERENCES recruitment_import_jobs(id) ON DELETE SET NULL,
  previous_hash TEXT NOT NULL,
  current_hash TEXT NOT NULL,
  changed_fields TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX recruitment_posting_changes_posting_idx
ON recruitment_posting_changes(posting_id,created_at DESC);

CREATE TABLE recruitment_clusters (
  id TEXT PRIMARY KEY,
  representative_posting_id TEXT NOT NULL REFERENCES recruitment_postings(id),
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  location TEXT,
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE recruitment_cluster_members (
  cluster_id TEXT NOT NULL REFERENCES recruitment_clusters(id) ON DELETE CASCADE,
  posting_id TEXT NOT NULL UNIQUE REFERENCES recruitment_postings(id) ON DELETE CASCADE,
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  assignment_source TEXT NOT NULL CHECK (assignment_source IN ('automatic','manual')),
  locked INTEGER NOT NULL CHECK (locked IN (0,1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(cluster_id,posting_id)
);

CREATE TABLE recruitment_cluster_suggestions (
  cluster_id TEXT NOT NULL REFERENCES recruitment_clusters(id) ON DELETE CASCADE,
  candidate_cluster_id TEXT NOT NULL REFERENCES recruitment_clusters(id) ON DELETE CASCADE,
  score REAL NOT NULL CHECK (score BETWEEN 0 AND 1),
  evidence TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(cluster_id,candidate_cluster_id)
);

CREATE TABLE recruitment_posting_profiles (
  posting_id TEXT NOT NULL REFERENCES recruitment_postings(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES recruitment_search_profiles(id) ON DELETE CASCADE,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  reasons TEXT NOT NULL,
  matched_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(posting_id,profile_id)
);
CREATE INDEX recruitment_posting_profiles_profile_idx
ON recruitment_posting_profiles(profile_id,score DESC,updated_at DESC);

CREATE TABLE recruitment_user_states (
  cluster_id TEXT PRIMARY KEY REFERENCES recruitment_clusters(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN (
    'untracked','saved','planned','applied','interviewing','offer','rejected','withdrawn','ignored'
  )),
  note TEXT NOT NULL DEFAULT '',
  applied_at TEXT,
  interviewing_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE recruitment_match_events (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES recruitment_search_profiles(id) ON DELETE CASCADE,
  cluster_id TEXT NOT NULL REFERENCES recruitment_clusters(id) ON DELETE CASCADE,
  posting_id TEXT NOT NULL REFERENCES recruitment_postings(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('recruitment.match.detected','recruitment.posting.changed')),
  content_hash TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  reasons TEXT NOT NULL,
  created_at TEXT NOT NULL,
  notified_at TEXT,
  digested_at TEXT,
  UNIQUE(profile_id,cluster_id,event_type,content_hash)
);
CREATE INDEX recruitment_match_events_digest_idx
ON recruitment_match_events(profile_id,digested_at,created_at);
`;
