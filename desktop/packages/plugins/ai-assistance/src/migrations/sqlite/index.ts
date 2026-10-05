export const aiAssistanceSqliteMigration001 = `
CREATE TABLE ai_provider_settings (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id=1),
  base_url TEXT,
  model TEXT,
  api_key_ref TEXT,
  tested_at TEXT,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO ai_provider_settings(singleton_id,base_url,model,api_key_ref,tested_at,revision,updated_at)
VALUES (1,NULL,NULL,NULL,NULL,1,CURRENT_TIMESTAMP);

CREATE TABLE ai_conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'active','awaiting_site_confirmation','draft_ready','testing',
    'awaiting_confirmation','committing','committed','failed','archived'
  )),
  latest_draft_revision INTEGER NOT NULL DEFAULT 0,
  committed_task_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX ai_conversations_activity_idx ON ai_conversations(updated_at DESC,id DESC);

CREATE TABLE ai_turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','canceled')),
  attempt INTEGER NOT NULL,
  model_rounds INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX ai_turns_conversation_idx ON ai_turns(conversation_id,created_at,id);

CREATE TABLE ai_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  turn_id TEXT REFERENCES ai_turns(id) ON DELETE SET NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(conversation_id,sequence)
);
CREATE INDEX ai_messages_conversation_idx ON ai_messages(conversation_id,sequence);

CREATE TABLE ai_draft_versions (
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  draft TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(conversation_id,revision)
);

CREATE TABLE ai_tool_invocations (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES ai_turns(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (name IN (
    'search_sites','inspect_page','update_task_draft','generate_rule','test_rule','present_draft'
  )),
  arguments TEXT NOT NULL,
  result TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE(turn_id,tool_call_id)
);
`;
