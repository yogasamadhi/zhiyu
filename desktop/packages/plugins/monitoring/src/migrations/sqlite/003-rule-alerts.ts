export const monitoringSqliteMigration003 = `
CREATE TABLE quality_rule_state (
  task_id TEXT NOT NULL,
  rule_key TEXT NOT NULL,
  policy_signature TEXT NOT NULL,
  consecutive_count INTEGER NOT NULL CHECK (consecutive_count >= 0),
  last_notification_at TEXT,
  last_run_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(task_id,rule_key)
);
CREATE TABLE quality_alerts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  rule_key TEXT NOT NULL,
  rule_kind TEXT NOT NULL,
  field TEXT,
  policy_signature TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','resolved','dismissed')),
  first_run_id TEXT NOT NULL,
  last_run_id TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL CHECK (occurrence_count >= 1),
  notification_count INTEGER NOT NULL CHECK (notification_count >= 0),
  suppressed_count INTEGER NOT NULL CHECK (suppressed_count >= 0),
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  latest_issue TEXT NOT NULL
);
CREATE INDEX quality_alerts_task_idx ON quality_alerts(task_id,first_at DESC,id DESC);
CREATE INDEX quality_alerts_aggregation_idx ON quality_alerts(task_id,rule_key,policy_signature,status,last_at DESC);
CREATE TABLE quality_alert_runs (
  alert_id TEXT NOT NULL REFERENCES quality_alerts(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  evaluation_id TEXT NOT NULL REFERENCES quality_evaluations(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN ('ready','cooldown','consecutive','no-notification')),
  occurred_at TEXT NOT NULL,
  PRIMARY KEY(alert_id,run_id)
);
CREATE INDEX quality_alert_runs_trace_idx ON quality_alert_runs(alert_id,occurred_at DESC,run_id DESC);
`;
