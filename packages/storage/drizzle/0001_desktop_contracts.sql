ALTER TYPE "public"."run_status" ADD VALUE IF NOT EXISTS 'canceled';
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "credential_bindings" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "revision" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_schedules" (
  "task_id" uuid PRIMARY KEY REFERENCES "tasks"("id") ON DELETE cascade,
  "cron" text NOT NULL,
  "timezone" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "runtime_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE cascade,
  "run_id" uuid REFERENCES "runs"("id") ON DELETE cascade,
  "state" text NOT NULL,
  "available_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "runtime_jobs_state_idx" ON "runtime_jobs" ("state", "available_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "domain_events" (
  "cursor" bigserial PRIMARY KEY,
  "id" uuid DEFAULT gen_random_uuid() NOT NULL UNIQUE,
  "type" text NOT NULL,
  "aggregate_type" text NOT NULL,
  "aggregate_id" text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "domain_events_aggregate_idx" ON "domain_events" ("aggregate_type", "aggregate_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "idempotency_keys" (
  "scope" text NOT NULL,
  "key" text NOT NULL,
  "fingerprint" text NOT NULL,
  "response" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idempotency_scope_key_uq" ON "idempotency_keys" ("scope", "key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "artifacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "runs"("id") ON DELETE cascade,
  "format" text NOT NULL,
  "filename" text NOT NULL,
  "content_type" text NOT NULL,
  "size" integer NOT NULL,
  "storage_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_run_idx" ON "artifacts" ("run_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runs_one_active_per_task_uq"
  ON "runs" ("task_id") WHERE "status" IN ('queued', 'running');
