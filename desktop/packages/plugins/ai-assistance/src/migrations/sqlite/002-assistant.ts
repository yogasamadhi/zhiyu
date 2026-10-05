export const assistantMigration002 = `
CREATE TABLE ai_assistant_records (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('session','action','blocks','tool')),
  revision INTEGER NOT NULL,
  value TEXT NOT NULL
);
CREATE INDEX ai_assistant_records_conversation_idx ON ai_assistant_records(conversation_id,kind);
CREATE TABLE ai_tool_invocations_v2 (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES ai_turns(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (name IN ('search_sites','inspect_page','update_task_draft','generate_rule','test_rule','present_draft','search_help','read_context','show_lesson','navigate','prepare_action','diagnose','prepare_repair')),
  arguments TEXT NOT NULL, result TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
  error TEXT, created_at TEXT NOT NULL, finished_at TEXT,
  UNIQUE(turn_id,tool_call_id)
);
INSERT INTO ai_tool_invocations_v2 SELECT * FROM ai_tool_invocations;
DROP TABLE ai_tool_invocations;
ALTER TABLE ai_tool_invocations_v2 RENAME TO ai_tool_invocations;
`;
