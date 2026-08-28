CREATE TYPE "public"."task_status" AS ENUM('draft', 'ready', 'running', 'succeeded', 'failed');
--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'succeeded', 'failed');
--> statement-breakpoint
CREATE TYPE "public"."generated_by" AS ENUM('human', 'ai', 'system');
--> statement-breakpoint
CREATE TABLE "tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "start_url" text NOT NULL,
  "instruction" text NOT NULL,
  "status" "task_status" DEFAULT 'draft' NOT NULL,
  "schedule" jsonb NOT NULL,
  "request_settings" jsonb NOT NULL,
  "browser_settings" jsonb NOT NULL,
  "pagination" jsonb NOT NULL,
  "output_settings" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL,
  "name" text NOT NULL,
  "active_version_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rule_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "rule_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "definition" jsonb NOT NULL,
  "generated_by" "generated_by" NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL,
  "status" "run_status" DEFAULT 'queued' NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "request_count" integer DEFAULT 0 NOT NULL,
  "record_count" integer DEFAULT 0 NOT NULL,
  "browser_used" boolean DEFAULT false NOT NULL,
  "ai_used" boolean DEFAULT false NOT NULL,
  "error" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "task_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "source_url" text NOT NULL,
  "data" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "rule_versions" ADD CONSTRAINT "rule_versions_rule_id_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."rules"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_active_version_id_rule_versions_id_fk" FOREIGN KEY ("active_version_id") REFERENCES "public"."rule_versions"("id") ON DELETE set null DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "records" ADD CONSTRAINT "records_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "rules_task_idx" ON "rules" USING btree ("task_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "rule_versions_rule_version_uq" ON "rule_versions" USING btree ("rule_id", "version");
--> statement-breakpoint
CREATE INDEX "runs_task_created_idx" ON "runs" USING btree ("task_id", "created_at");
--> statement-breakpoint
CREATE INDEX "records_run_idx" ON "records" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "records_task_idx" ON "records" USING btree ("task_id");
