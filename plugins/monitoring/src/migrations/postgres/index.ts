export const monitoringPostgresMigration001 = `
CREATE TABLE quality_policies (
  task_id TEXT PRIMARY KEY,
  policy JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE quality_evaluations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('unknown','healthy','warning','failing')),
  profile JSONB NOT NULL,
  issues JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX monitoring_evaluations_task_idx
ON quality_evaluations(task_id,created_at DESC,id DESC);
`;

export const monitoringPostgresMigration002 = `
CREATE TABLE quality_task_state (
  task_id TEXT PRIMARY KEY,
  ever_nonempty BOOLEAN NOT NULL,
  open_issue BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE quality_notifications (
  event_id TEXT PRIMARY KEY,
  evaluation_id TEXT NOT NULL UNIQUE REFERENCES quality_evaluations(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL CHECK (event_type IN ('quality.issue.detected','quality.recovered')),
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','error')),
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  delivered_at TIMESTAMPTZ
);
CREATE INDEX monitoring_notifications_pending_idx
ON quality_notifications(delivered_at,occurred_at,event_id);

INSERT INTO quality_task_state(task_id,ever_nonempty,open_issue,updated_at)
SELECT
  evaluations.task_id,
  BOOL_OR(COALESCE((profile->>'recordCount')::integer,0) > 0),
  COALESCE(latest_transition.open_issue,FALSE),
  MAX(created_at)
FROM quality_evaluations evaluations
LEFT JOIN LATERAL (
  SELECT candidate.status<>'healthy' AS open_issue
  FROM quality_evaluations candidate
  WHERE candidate.task_id=evaluations.task_id
    AND (
      candidate.status='healthy'
      OR (candidate.status IN ('warning','failing') AND candidate.issues <> '[]'::jsonb)
    )
  ORDER BY candidate.created_at DESC,candidate.id DESC
  LIMIT 1
) latest_transition ON TRUE
GROUP BY evaluations.task_id,latest_transition.open_issue;
`;
