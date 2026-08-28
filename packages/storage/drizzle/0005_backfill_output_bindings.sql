INSERT INTO "task_output_bindings" ("task_id", "destination_id", "created_at")
SELECT t."id", binding.value::uuid, now()
FROM "tasks" t
CROSS JOIN LATERAL jsonb_array_elements_text(t."output_bindings") AS binding(value)
JOIN "output_destinations" destination ON destination."id" = binding.value::uuid
ON CONFLICT ("task_id", "destination_id") DO NOTHING;
