export const identityPostgresMigration001 = `
CREATE TABLE identity_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX identity_users_role_active_idx ON identity_users(role,disabled);

CREATE TABLE identity_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token_hash TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  idle_expires_at TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (idle_expires_at <= absolute_expires_at)
);
CREATE INDEX identity_sessions_user_active_idx ON identity_sessions(user_id,revoked_at);
CREATE INDEX identity_sessions_expiry_idx ON identity_sessions(idle_expires_at,absolute_expires_at);

CREATE TABLE identity_invitations (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL REFERENCES identity_users(id),
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX identity_invitations_active_email_idx ON identity_invitations(email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX identity_invitations_expiry_idx ON identity_invitations(expires_at);

CREATE TABLE identity_password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES identity_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL REFERENCES identity_users(id),
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (NOT (consumed_at IS NOT NULL AND revoked_at IS NOT NULL))
);
CREATE INDEX identity_password_resets_user_idx ON identity_password_reset_tokens(user_id,created_at DESC);
CREATE INDEX identity_password_resets_expiry_idx ON identity_password_reset_tokens(expires_at);

CREATE TABLE identity_login_attempts (
  id TEXT PRIMARY KEY,
  email_hash TEXT NOT NULL,
  network_hash TEXT NOT NULL,
  succeeded BOOLEAN NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX identity_login_attempts_limit_idx
  ON identity_login_attempts(email_hash,network_hash,occurred_at DESC)
  WHERE succeeded=FALSE;

CREATE TABLE identity_audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES identity_users(id) ON DELETE SET NULL,
  operation_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  result TEXT NOT NULL CHECK (result IN ('succeeded','failed','denied')),
  trace_id TEXT,
  network_hash TEXT,
  details JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX identity_audit_cursor_idx ON identity_audit_events(occurred_at DESC,id DESC);
CREATE INDEX identity_audit_actor_idx ON identity_audit_events(actor_user_id,occurred_at DESC);
`;
