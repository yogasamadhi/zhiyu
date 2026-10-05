export const monitoringSqliteMigration001 = `
CREATE TABLE quality_policies (
  task_id TEXT PRIMARY KEY,
  policy TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE quality_evaluations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('unknown','healthy','warning','failing')),
  profile TEXT NOT NULL,
  issues TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX monitoring_evaluations_task_idx
ON quality_evaluations(task_id,created_at DESC,id DESC);
`;

export const monitoringSqliteMigration002 = `
CREATE TABLE quality_task_state (
  task_id TEXT PRIMARY KEY,
  ever_nonempty INTEGER NOT NULL CHECK (ever_nonempty IN (0,1)),
  open_issue INTEGER NOT NULL CHECK (open_issue IN (0,1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE quality_notifications (
  event_id TEXT PRIMARY KEY,
  evaluation_id TEXT NOT NULL UNIQUE REFERENCES quality_evaluations(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK (event_type IN ('quality.issue.detected','quality.recovered')),
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','error')),
  payload TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX monitoring_notifications_pending_idx
ON quality_notifications(delivered_at,occurred_at,event_id);

INSERT INTO quality_task_state(task_id,ever_nonempty,open_issue,updated_at)
SELECT
  grouped.task_id,
  grouped.ever_nonempty,
  COALESCE((
    SELECT CASE WHEN transition.status='healthy' THEN 0 ELSE 1 END
    FROM quality_evaluations transition
    WHERE transition.task_id=grouped.task_id
      AND (
        transition.status='healthy'
        OR (
          transition.status IN ('warning','failing')
          AND json_array_length(transition.issues) > 0
        )
      )
    ORDER BY transition.created_at DESC,transition.id DESC
    LIMIT 1
  ),0),
  grouped.updated_at
FROM (
  SELECT
    task_id,
    MAX(CASE WHEN CAST(json_extract(profile,'$.recordCount') AS INTEGER) > 0 THEN 1 ELSE 0 END)
      AS ever_nonempty,
    MAX(created_at) AS updated_at
  FROM quality_evaluations
  GROUP BY task_id
) grouped;
`;
