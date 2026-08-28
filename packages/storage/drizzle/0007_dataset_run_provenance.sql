ALTER TABLE "dataset_records"
  DROP CONSTRAINT IF EXISTS "dataset_records_first_run_id_runs_id_fk";
ALTER TABLE "dataset_records"
  DROP CONSTRAINT IF EXISTS "dataset_records_last_run_id_runs_id_fk";
ALTER TABLE "dataset_records" ALTER COLUMN "first_run_id" DROP NOT NULL;
ALTER TABLE "dataset_records" ALTER COLUMN "last_run_id" DROP NOT NULL;
ALTER TABLE "dataset_records"
  ADD CONSTRAINT "dataset_records_first_run_id_runs_id_fk"
  FOREIGN KEY ("first_run_id") REFERENCES "public"."runs"("id") ON DELETE set null;
ALTER TABLE "dataset_records"
  ADD CONSTRAINT "dataset_records_last_run_id_runs_id_fk"
  FOREIGN KEY ("last_run_id") REFERENCES "public"."runs"("id") ON DELETE set null;
