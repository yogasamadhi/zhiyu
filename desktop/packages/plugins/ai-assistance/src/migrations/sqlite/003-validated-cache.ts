export const validatedCacheMigration003 = `
CREATE TABLE ai_validated_cache_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton=1),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation>=0)
);
INSERT INTO ai_validated_cache_state(singleton,generation) VALUES (1,0);
CREATE TABLE ai_validated_cache (
  kind TEXT NOT NULL CHECK (kind IN ('rule','action')),
  scope_hash TEXT NOT NULL CHECK (length(scope_hash)=64),
  session_hash TEXT NOT NULL CHECK (length(session_hash)=64),
  rule_hash TEXT NOT NULL CHECK (length(rule_hash)=64),
  configuration_hash TEXT NOT NULL CHECK (length(configuration_hash)=64),
  provider_hash TEXT NOT NULL CHECK (length(provider_hash)=64),
  prompt_hash TEXT NOT NULL CHECK (length(prompt_hash)=64),
  action_hash TEXT NOT NULL CHECK (length(action_hash)=64),
  structure_hash TEXT NOT NULL CHECK (length(structure_hash)=64),
  key_hash TEXT NOT NULL UNIQUE CHECK (length(key_hash)=64),
  payload TEXT NOT NULL CHECK (length(CAST(payload AS BLOB))<=32768),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash)=64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at>created_at),
  last_used_at INTEGER NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0 CHECK (hit_count>=0),
  PRIMARY KEY(scope_hash,kind)
);
CREATE INDEX ai_validated_cache_lru ON ai_validated_cache(last_used_at,key_hash);
`;
