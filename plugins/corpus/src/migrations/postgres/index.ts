export const corpusPostgresMigration001 = `
CREATE TABLE corpora (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  dataset_id UUID NOT NULL,
  revision INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX corpora_cursor_idx ON corpora(created_at DESC,id DESC);

CREATE TABLE corpus_recipes (
  id UUID PRIMARY KEY,
  corpus_id UUID NOT NULL REFERENCES corpora(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  dataset_id UUID NOT NULL,
  snapshot_policy JSONB NOT NULL,
  selected_text_fields JSONB NOT NULL,
  metadata_fields JSONB NOT NULL,
  strip_html BOOLEAN NOT NULL,
  unicode_normalization TEXT NOT NULL,
  deduplication TEXT NOT NULL,
  near_duplicate_threshold DOUBLE PRECISION NOT NULL,
  chunk_size INTEGER NOT NULL,
  chunk_overlap INTEGER NOT NULL,
  language_policy TEXT NOT NULL,
  output_formats JSONB NOT NULL,
  revision INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX corpus_recipes_owner_idx ON corpus_recipes(corpus_id,created_at DESC,id DESC);

CREATE TABLE corpus_builds (
  id UUID PRIMARY KEY,
  corpus_id UUID NOT NULL REFERENCES corpora(id) ON DELETE CASCADE,
  recipe_id UUID NOT NULL REFERENCES corpus_recipes(id),
  recipe_revision INTEGER NOT NULL,
  dataset_id UUID NOT NULL,
  snapshot_id UUID NOT NULL,
  version_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX corpus_builds_owner_idx ON corpus_builds(corpus_id,created_at DESC,id DESC);

CREATE TABLE corpus_versions (
  id UUID PRIMARY KEY,
  corpus_id UUID NOT NULL REFERENCES corpora(id) ON DELETE CASCADE,
  build_id UUID NOT NULL UNIQUE REFERENCES corpus_builds(id) ON DELETE CASCADE,
  dataset_id UUID NOT NULL,
  snapshot_id UUID NOT NULL,
  snapshot_fingerprint TEXT NOT NULL,
  recipe_id UUID NOT NULL,
  recipe_revision INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  worker_version TEXT NOT NULL,
  stats JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(corpus_id,fingerprint)
);
CREATE INDEX corpus_versions_owner_idx ON corpus_versions(corpus_id,created_at DESC,id DESC);

CREATE TABLE corpus_artifacts (
  version_id UUID NOT NULL REFERENCES corpus_versions(id) ON DELETE CASCADE,
  artifact_id UUID NOT NULL,
  kind TEXT NOT NULL,
  content_type TEXT NOT NULL,
  filename TEXT NOT NULL,
  checksum TEXT NOT NULL,
  size BIGINT NOT NULL,
  PRIMARY KEY(version_id,artifact_id)
);
`;
