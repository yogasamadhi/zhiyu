ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "dataset_settings" jsonb
  DEFAULT '{"mode":"snapshot","keyFields":[],"detectRemoved":true}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "retention_policy" jsonb
  DEFAULT '{"runDays":null,"maxRuns":null,"artifactDays":null,"logDays":null}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "network_policy" jsonb
  DEFAULT '{"allowPrivateNetworks":false,"allowedHosts":[],"allowedCidrs":[]}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "output_bindings" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "error_code" text;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "phase" text DEFAULT 'queued' NOT NULL;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "progress" real DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "cancel_requested_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "dataset_stats" jsonb
  DEFAULT '{"added":0,"updated":0,"removed":0,"unchanged":0,"current":0}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "delivery_status" text DEFAULT 'idle' NOT NULL;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "warning_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "rule_versions"
SET "definition" = jsonb_build_object(
  'version', 1,
  'list', jsonb_build_object('rule', "definition", 'mode', 'auto', 'actions', '[]'::jsonb),
  'pagination', jsonb_build_object('type', 'none'),
  'dedupe', jsonb_build_object('strategy', 'hash', 'fields', '[]'::jsonb),
  'limits', jsonb_build_object('maxRecords', 1000000)
)
WHERE "definition" ? 'type';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "datasets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL UNIQUE REFERENCES "tasks"("id") ON DELETE cascade,
  "settings" jsonb NOT NULL,
  "current_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dataset_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "dataset_id" uuid NOT NULL REFERENCES "datasets"("id") ON DELETE cascade,
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE cascade,
  "record_key" text NOT NULL,
  "source_url" text NOT NULL,
  "data" jsonb NOT NULL,
  "content_hash" text NOT NULL,
  "removed" boolean DEFAULT false NOT NULL,
  "first_run_id" uuid NOT NULL REFERENCES "runs"("id") ON DELETE cascade,
  "last_run_id" uuid NOT NULL REFERENCES "runs"("id") ON DELETE cascade,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dataset_records_dataset_key_uq" ON "dataset_records" ("dataset_id", "record_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dataset_records_task_removed_idx" ON "dataset_records" ("task_id", "removed", "last_seen_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "record_changes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "dataset_id" uuid NOT NULL REFERENCES "datasets"("id") ON DELETE cascade,
  "dataset_record_id" uuid NOT NULL REFERENCES "dataset_records"("id") ON DELETE cascade,
  "run_id" uuid NOT NULL REFERENCES "runs"("id") ON DELETE cascade,
  "type" text NOT NULL CHECK ("type" IN ('added','updated','removed')),
  "before" jsonb,
  "after" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "record_changes_dataset_created_idx" ON "record_changes" ("dataset_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "run_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "runs"("id") ON DELETE cascade,
  "sequence" integer NOT NULL,
  "level" text NOT NULL,
  "phase" text NOT NULL,
  "message" text NOT NULL,
  "url" text,
  "error_code" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  UNIQUE ("run_id", "sequence")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "run_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "runs"("id") ON DELETE cascade,
  "url" text NOT NULL,
  "kind" text NOT NULL,
  "status" text NOT NULL,
  "status_code" integer,
  "duration_ms" integer NOT NULL,
  "error_code" text,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "run_requests_run_created_idx" ON "run_requests" ("run_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "output_destinations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "type" text NOT NULL CHECK ("type" IN ('webhook','postgres')),
  "config" jsonb NOT NULL,
  "credential_ref" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_output_bindings" (
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE cascade,
  "destination_id" uuid NOT NULL REFERENCES "output_destinations"("id") ON DELETE cascade,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("task_id", "destination_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "delivery_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "destination_id" uuid NOT NULL REFERENCES "output_destinations"("id") ON DELETE cascade,
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE cascade,
  "run_id" uuid NOT NULL REFERENCES "runs"("id") ON DELETE cascade,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempt" integer DEFAULT 1 NOT NULL,
  "response_status" integer,
  "error" text,
  "next_attempt_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "delivery_attempts_run_idx" ON "delivery_attempts" ("run_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "token_hash" text NOT NULL UNIQUE,
  "task_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "expires_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rule_repair_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE cascade,
  "rule_id" uuid NOT NULL REFERENCES "rules"("id") ON DELETE cascade,
  "run_id" uuid REFERENCES "runs"("id") ON DELETE set null,
  "definition" jsonb NOT NULL,
  "explanation" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
