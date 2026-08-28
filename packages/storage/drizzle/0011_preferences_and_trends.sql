CREATE TABLE IF NOT EXISTS "trend_sources" (
  "key" text PRIMARY KEY,
  "platform" text NOT NULL,
  "task_id" uuid UNIQUE REFERENCES "tasks"("id") ON DELETE SET NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "auto_refresh" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "trend_sources_task_idx" ON "trend_sources" ("task_id");

CREATE TABLE IF NOT EXISTS "preference_signals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "target_key" text NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('like', 'dislike', 'completed')),
  "platform" text NOT NULL,
  "content_type" text NOT NULL,
  "external_id" text NOT NULL,
  "title" text NOT NULL,
  "content" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "preference_signals_target_kind_uq"
  ON "preference_signals" ("target_key", "kind");
CREATE INDEX IF NOT EXISTS "preference_signals_updated_idx"
  ON "preference_signals" ("updated_at" DESC);
