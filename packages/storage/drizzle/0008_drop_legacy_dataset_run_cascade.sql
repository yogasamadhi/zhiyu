ALTER TABLE "dataset_records"
  DROP CONSTRAINT IF EXISTS "dataset_records_first_run_id_fkey";
ALTER TABLE "dataset_records"
  DROP CONSTRAINT IF EXISTS "dataset_records_last_run_id_fkey";
