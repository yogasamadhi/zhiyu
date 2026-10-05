import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  monitoringAlertOccurrenceSchema,
  monitoringAlertSchema,
  qualityIssueSchema,
  type QualityEvaluation,
  type QualityPolicy,
} from '@zhiyun/shared';
import { MonitoringCursorError, type MonitoringAlert } from '../../contracts/index.js';

type Row = Record<string, unknown>;
export class SqliteRuleAlerts {
  constructor(private readonly sqlite: Database.Database) {}

  // Called inside the same transaction as the immutable evaluation and notification outbox.
  evaluate(evaluation: QualityEvaluation, policy: QualityPolicy, notificationCandidate: boolean) {
    const states = new Map(
      (
        this.sqlite
          .prepare('SELECT * FROM quality_rule_state WHERE task_id=?')
          .all(evaluation.taskId) as Row[]
      ).map((row) => [String(row.rule_key), row]),
    );
    this.sqlite
      .prepare(
        'UPDATE quality_rule_state SET consecutive_count=0,last_run_id=?,updated_at=? WHERE task_id=?',
      )
      .run(evaluation.runId, evaluation.createdAt, evaluation.taskId);
    const eligible: QualityEvaluation['issues'] = [],
      alertIds: string[] = [];
    const activeIssues = new Map<string, string>();
    for (const issue of evaluation.issues) {
      const rule = policy.enabled
        ? policy.rules.find((item) => item.kind === issue.kind && item.enabled)
        : undefined;
      if (!rule) continue;
      const key = JSON.stringify([issue.kind, issue.field]);
      const signature = ruleSignature(rule, policy);
      activeIssues.set(key, signature);
      const old = states.get(key);
      const state = old?.policy_signature === signature ? old : undefined;
      const consecutive = Number(state?.consecutive_count ?? 0) + 1;
      const minimum = rule.consecutiveRuns ?? 1;
      const lastNotification =
        typeof state?.last_notification_at === 'string' ? state.last_notification_at : null;
      const cooldown = (rule.cooldownSeconds ?? 0) * 1000;
      const cooled =
        !lastNotification ||
        Date.parse(evaluation.createdAt) - Date.parse(lastNotification) >= cooldown;
      const ready = notificationCandidate && consecutive >= minimum && cooled;
      const reason: MonitoringAlert['runs'][number]['reason'] = !notificationCandidate
        ? 'no-notification'
        : consecutive < minimum
          ? 'consecutive'
          : !cooled
            ? 'cooldown'
            : 'ready';
      const aggregateSeconds = rule.aggregationSeconds ?? 0;
      const existing =
        aggregateSeconds > 0
          ? (this.sqlite
              .prepare(
                "SELECT * FROM quality_alerts WHERE task_id=? AND rule_key=? AND policy_signature=? AND status='open' AND last_at>=? ORDER BY last_at DESC,id DESC LIMIT 1",
              )
              .get(
                evaluation.taskId,
                key,
                signature,
                new Date(Date.parse(evaluation.createdAt) - aggregateSeconds * 1000).toISOString(),
              ) as Row | undefined)
          : undefined;
      const id = existing ? String(existing.id) : randomUUID();
      if (existing)
        this.sqlite
          .prepare(
            'UPDATE quality_alerts SET last_run_id=?,occurrence_count=occurrence_count+1,notification_count=notification_count+?,suppressed_count=suppressed_count+?,last_at=?,latest_issue=? WHERE id=?',
          )
          .run(
            evaluation.runId,
            Number(ready),
            Number(!ready),
            evaluation.createdAt,
            JSON.stringify(issue),
            id,
          );
      else
        this.sqlite
          .prepare(
            "INSERT INTO quality_alerts(id,task_id,rule_key,rule_kind,field,policy_signature,status,first_run_id,last_run_id,occurrence_count,notification_count,suppressed_count,first_at,last_at,latest_issue) VALUES (?,?,?,?,?,?,'open',?,?,1,?,?,?,?,?)",
          )
          .run(
            id,
            evaluation.taskId,
            key,
            issue.kind,
            issue.field,
            signature,
            evaluation.runId,
            evaluation.runId,
            Number(ready),
            Number(!ready),
            evaluation.createdAt,
            evaluation.createdAt,
            JSON.stringify(issue),
          );
      this.sqlite
        .prepare(
          'INSERT INTO quality_alert_runs(alert_id,run_id,evaluation_id,reason,occurred_at) VALUES (?,?,?,?,?)',
        )
        .run(id, evaluation.runId, evaluation.id, reason, evaluation.createdAt);
      this.sqlite
        .prepare(
          'INSERT INTO quality_rule_state(task_id,rule_key,policy_signature,consecutive_count,last_notification_at,last_run_id,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(task_id,rule_key) DO UPDATE SET policy_signature=excluded.policy_signature,consecutive_count=excluded.consecutive_count,last_notification_at=excluded.last_notification_at,last_run_id=excluded.last_run_id,updated_at=excluded.updated_at',
        )
        .run(
          evaluation.taskId,
          key,
          signature,
          consecutive,
          ready ? evaluation.createdAt : lastNotification,
          evaluation.runId,
          evaluation.createdAt,
        );
      this.event(
        existing ? 'monitoring.alert.updated' : 'monitoring.alert.created',
        id,
        evaluation.taskId,
        evaluation.runId,
        evaluation.createdAt,
      );
      if (ready) {
        eligible.push(issue);
        alertIds.push(id);
      }
    }
    if (evaluation.status === 'healthy' || evaluation.status === 'warning') {
      const open = this.sqlite
        .prepare(
          "SELECT id,rule_key,policy_signature FROM quality_alerts WHERE task_id=? AND status='open'",
        )
        .all(evaluation.taskId) as Row[];
      for (const alert of open) {
        if (activeIssues.get(String(alert.rule_key)) === alert.policy_signature) continue;
        this.sqlite.prepare("UPDATE quality_alerts SET status='resolved' WHERE id=?").run(alert.id);
        this.event(
          'monitoring.alert.resolved',
          String(alert.id),
          evaluation.taskId,
          evaluation.runId,
          evaluation.createdAt,
        );
      }
    }
    return { eligible, alertIds };
  }

  list(taskId: string, limit = 50): MonitoringAlert[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error('Alert limit must be between 1 and 500');
    return (
      this.sqlite
        .prepare(
          'SELECT * FROM quality_alerts WHERE task_id=? ORDER BY first_at DESC,id DESC LIMIT ?',
        )
        .all(taskId, limit) as Row[]
    ).map((row) => this.alert(row));
  }

  listPage(taskId: string, cursor?: string, limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error('Alert limit must be between 1 and 500');
    let after: { at: string; id: string } | undefined;
    if (cursor) {
      try {
        if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
        const bytes = Buffer.from(cursor, 'base64url');
        if (bytes.toString('base64url') !== cursor) throw new Error();
        const value = JSON.parse(bytes.toString('utf8')) as Row;
        if (
          value.v !== 1 ||
          value.taskId !== taskId ||
          Object.keys(value).sort().join(',') !== 'at,id,taskId,v'
        )
          throw new Error();
        const parsed = monitoringAlertSchema
          .pick({ id: true, firstAt: true })
          .parse({ id: value.id, firstAt: value.at });
        after = { id: parsed.id, at: parsed.firstAt };
      } catch {
        throw new MonitoringCursorError('Invalid or mismatched monitoring list cursor');
      }
    }
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM quality_alerts WHERE task_id=?
      ${after ? 'AND (first_at<? OR (first_at=? AND id<?))' : ''}
      ORDER BY first_at DESC,id DESC LIMIT ?`,
      )
      .all(
        ...(after ? [taskId, after.at, after.at, after.id, limit + 1] : [taskId, limit + 1]),
      ) as Row[];
    const visible = rows.slice(0, limit),
      last = visible.at(-1);
    return {
      items: visible.map((row) => this.alert(row)),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify({ v: 1, taskId, at: last.first_at, id: last.id })).toString(
              'base64url',
            )
          : null,
    };
  }

  dismiss(taskId: string, alertId: string): MonitoringAlert | null {
    return this.sqlite.transaction(() => {
      const row = this.sqlite
        .prepare('SELECT * FROM quality_alerts WHERE task_id=? AND id=?')
        .get(taskId, alertId) as Row | undefined;
      if (!row) return null;
      if (row.status !== 'dismissed') {
        this.sqlite.prepare("UPDATE quality_alerts SET status='dismissed' WHERE id=?").run(alertId);
        this.event(
          'monitoring.alert.deleted',
          alertId,
          taskId,
          String(row.last_run_id),
          new Date().toISOString(),
        );
        row.status = 'dismissed';
      }
      return this.alert(row);
    })();
  }

  listRuns(taskId: string, alertId: string, cursor?: string, limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error('Trace limit must be between 1 and 500');
    const after = cursor ? decodeCursor(cursor, taskId, alertId) : null;
    if (
      !this.sqlite
        .prepare('SELECT 1 FROM quality_alerts WHERE task_id=? AND id=?')
        .get(taskId, alertId)
    )
      return null;
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM quality_alert_runs WHERE alert_id=?
       ${after ? 'AND (occurred_at<? OR (occurred_at=? AND run_id<?))' : ''}
       ORDER BY occurred_at DESC,run_id DESC LIMIT ?`,
      )
      .all(
        ...(after ? [alertId, after.at, after.at, after.runId, limit + 1] : [alertId, limit + 1]),
      ) as Row[];
    const visible = rows.slice(0, limit),
      last = visible.at(-1);
    return {
      items: visible.map(occurrence),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({ v: 1, taskId, alertId, at: last.occurred_at, runId: last.run_id }),
            ).toString('base64url')
          : null,
    };
  }

  private alert(row: Row): MonitoringAlert {
    const runs = this.sqlite
      .prepare(
        'SELECT * FROM quality_alert_runs WHERE alert_id=? ORDER BY occurred_at DESC,run_id DESC LIMIT 20',
      )
      .all(row.id) as Row[];
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      kind: row.rule_kind as MonitoringAlert['kind'],
      field: typeof row.field === 'string' ? row.field : null,
      status: row.status as MonitoringAlert['status'],
      firstRunId: String(row.first_run_id),
      lastRunId: String(row.last_run_id),
      occurrenceCount: Number(row.occurrence_count),
      notificationCount: Number(row.notification_count),
      suppressedCount: Number(row.suppressed_count),
      firstAt: String(row.first_at),
      lastAt: String(row.last_at),
      latestIssue: qualityIssueSchema.parse(JSON.parse(String(row.latest_issue))),
      runs: runs.map(occurrence),
    };
  }

  private event(type: string, alertId: string, taskId: string, runId: string, at: string) {
    this.sqlite
      .prepare(
        "INSERT INTO platform_events(id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at) VALUES (?,?,1,'monitoring','monitoring-alert',?,?,?)",
      )
      .run(randomUUID(), type, alertId, JSON.stringify({ alertId, taskId, runId }), at);
  }
}

function occurrence(row: Row) {
  return monitoringAlertOccurrenceSchema.parse({
    runId: row.run_id,
    evaluationId: row.evaluation_id,
    reason: row.reason,
    occurredAt: row.occurred_at,
  });
}

function decodeCursor(
  cursor: string,
  taskId: string,
  alertId: string,
): { at: string; runId: string } {
  try {
    if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new Error();
    const value = JSON.parse(bytes.toString('utf8')) as Row;
    if (
      value.v !== 1 ||
      value.taskId !== taskId ||
      value.alertId !== alertId ||
      Object.keys(value).sort().join(',') !== 'alertId,at,runId,taskId,v'
    )
      throw new Error();
    const parsed = monitoringAlertOccurrenceSchema.pick({ runId: true, occurredAt: true }).parse({
      runId: value.runId,
      occurredAt: value.at,
    });
    return { at: parsed.occurredAt, runId: parsed.runId };
  } catch {
    throw new MonitoringCursorError('Invalid or mismatched monitoring cursor');
  }
}

function ruleSignature(rule: QualityPolicy['rules'][number], policy: QualityPolicy): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        ...rule,
        fields: [...rule.fields].sort(),
        excludeFields: [...(rule.excludeFields ?? [])].sort(),
        consecutiveRuns: rule.consecutiveRuns ?? 1,
        cooldownSeconds: rule.cooldownSeconds ?? 0,
        aggregationSeconds: rule.aggregationSeconds ?? 0,
        // Null-rate rules without an explicit mode preserve the older floor + delta semantics.
        thresholdMode: rule.thresholdMode ?? 'legacy',
        baselineRuns: policy.baselineRuns,
        minimumBaselineRuns: policy.minimumBaselineRuns,
      }),
    )
    .digest('hex');
}
