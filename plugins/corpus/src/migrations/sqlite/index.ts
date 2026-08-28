export const corpusSqliteMigration001 = `
CREATE TABLE corpora (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX corpora_cursor_idx ON corpora(created_at DESC,id DESC);

CREATE TABLE corpus_recipes (
  id TEXT PRIMARY KEY,
  corpus_id TEXT NOT NULL REFERENCES corpora(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  snapshot_policy TEXT NOT NULL,
  selected_text_fields TEXT NOT NULL,
  metadata_fields TEXT NOT NULL,
  strip_html INTEGER NOT NULL,
  unicode_normalization TEXT NOT NULL,
  deduplication TEXT NOT NULL,
  near_duplicate_threshold REAL NOT NULL,
  chunk_size INTEGER NOT NULL,
  chunk_overlap INTEGER NOT NULL,
  language_policy TEXT NOT NULL,
  output_formats TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX corpus_recipes_owner_idx ON corpus_recipes(corpus_id,created_at DESC,id DESC);

CREATE TABLE corpus_builds (
  id TEXT PRIMARY KEY,
  corpus_id TEXT NOT NULL REFERENCES corpora(id) ON DELETE CASCADE,
  recipe_id TEXT NOT NULL REFERENCES corpus_recipes(id),
  recipe_revision INTEGER NOT NULL,
  dataset_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  version_id TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX corpus_builds_owner_idx ON corpus_builds(corpus_id,created_at DESC,id DESC);

CREATE TABLE corpus_versions (
  id TEXT PRIMARY KEY,
  corpus_id TEXT NOT NULL REFERENCES corpora(id) ON DELETE CASCADE,
  build_id TEXT NOT NULL UNIQUE REFERENCES corpus_builds(id) ON DELETE CASCADE,
  dataset_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  snapshot_fingerprint TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  recipe_revision INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  worker_version TEXT NOT NULL,
  stats TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(corpus_id,fingerprint)
);
CREATE INDEX corpus_versions_owner_idx ON corpus_versions(corpus_id,created_at DESC,id DESC);

CREATE TABLE corpus_artifacts (
  version_id TEXT NOT NULL REFERENCES corpus_versions(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content_type TEXT NOT NULL,
  filename TEXT NOT NULL,
  checksum TEXT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY(version_id,artifact_id)
);
`;
