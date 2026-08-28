export const preferencesPostgresMigration001 = `
CREATE TABLE trend_sources (
  key TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  task_id TEXT UNIQUE,
  enabled BOOLEAN NOT NULL,
  auto_refresh BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX preferences_trend_sources_task_idx ON trend_sources(task_id);

CREATE TABLE preference_signals (
  id TEXT PRIMARY KEY,
  target_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('like','dislike','completed')),
  platform TEXT NOT NULL,
  content_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE(target_key,kind)
);
CREATE INDEX preferences_signals_cursor_idx ON preference_signals(updated_at DESC,id DESC);
`;
