CREATE INDEX IF NOT EXISTS "dataset_records_cursor_idx"
ON "dataset_records" ("task_id", "removed", "last_seen_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "record_changes_cursor_idx"
ON "record_changes" ("dataset_id", "created_at" DESC, "id" DESC);
