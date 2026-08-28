ALTER TABLE "records" ADD COLUMN IF NOT EXISTS "record_key" text;
ALTER TABLE "records" ADD COLUMN IF NOT EXISTS "content_hash" text;

UPDATE "records"
SET
  "record_key" = COALESCE("record_key", md5("data"::text)),
  "content_hash" = COALESCE("content_hash", md5("data"::text));

ALTER TABLE "records" ALTER COLUMN "record_key" SET NOT NULL;
ALTER TABLE "records" ALTER COLUMN "content_hash" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "records_run_key_idx" ON "records" ("run_id", "record_key");
