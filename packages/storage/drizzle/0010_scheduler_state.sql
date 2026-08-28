ALTER TABLE "task_schedules"
  ADD COLUMN IF NOT EXISTS "misfire_policy" text NOT NULL DEFAULT 'skip';
ALTER TABLE "task_schedules"
  ADD COLUMN IF NOT EXISTS "last_triggered_at" timestamptz;

UPDATE "tasks"
SET "schedule" = "schedule" || '{"misfirePolicy":"skip"}'::jsonb
WHERE NOT ("schedule" ? 'misfirePolicy');

CREATE TABLE IF NOT EXISTS "runtime_settings" (
  "key" text PRIMARY KEY,
  "value" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
