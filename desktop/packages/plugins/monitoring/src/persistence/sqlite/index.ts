import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { SqliteRuleAlerts } from './rule-alerts.js';
import { monitoringSqliteMigration003 } from '../../migrations/sqlite/003-rule-alerts.js';
import {
  qualityEvaluationSchema,
  qualityPolicySchema,
  qualityProfileSchema,
  type QualityEvaluation,
  type QualityPolicy,
  type QualityProfile,
  type TaskHealth,
} from '@zhiyun/shared';
import type {
  MonitoringRepository,
  QualityNotification,
  QualityNotificationDraft,
} from '../../contracts/index.js';
import { defaultQualityPolicy } from '../../domain/index.js';
import {
  monitoringSqliteMigration001,
  monitoringSqliteMigration002,
} from '../../migrations/sqlite/index.js';

type Row = Record<string, unknown>;
const MIGRATIONS = [
  { id: '001-initial', version: '1.0.0', sql: monitoringSqliteMigration001 },
  { id: '002-durable-notifications', version: '1.1.0', sql: monitoringSqliteMigration002 },
  { id: '003-rule-alerts', version: '1.2.0', sql: monitoringSqliteMigration003 },
] as const;

export class SqliteMonitoringRepository implements MonitoringRepository {
  private readonly sqlite: Database.Database;
  private readonly alerts: SqliteRuleAlerts;

  constructor(filePath: string) {
    this.sqlite = new Database(filePath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
    this.alerts = new SqliteRuleAlerts(this.sqlite);
  }

  async migrate(): Promise<void> {
    for (const migration of MIGRATIONS) {
      const checksum = sha256(migration.sql);
      const existing = this.sqlite
        .prepare('SELECT checksum FROM plugin_migrations WHERE plugin_id=? AND migration_id=?')
        .get('monitoring', migration.id) as Row | undefined;
      if (existing) {
        if (existing.checksum !== checksum) {
          throw new Error(`Migration checksum mismatch for monitoring:${migration.id}`);
        }
        continue;
      }
      const started = performance.now();
      this.sqlite.transaction(() => {
        this.sqlite.exec(migration.sql);
        this.sqlite
          .prepare(
            `INSERT INTO plugin_migrations(
               plugin_id,migration_id,plugin_version,checksum,executed_at,duration_ms,result
             ) VALUES ('monitoring',?,?,?,?,?,'succeeded')`,
          )
          .run(
            migration.id,
            migration.version,
            checksum,
            new Date().toISOString(),
            Math.max(0, Math.round(performance.now() - started)),
          );
      })();
    }
  }

  async close(): Promise<void> {
    if (this.sqlite.open) this.sqlite.close();
  }

  async getPolicy(taskId: string): Promise<QualityPolicy> {
    const row = this.sqlite
      .prepare('SELECT policy FROM quality_policies WHERE task_id=?')
      .get(taskId) as Row | undefined;
    return row ? qualityPolicySchema.parse(JSON.parse(String(row.policy))) : defaultQualityPolicy;
  }

  async upsertPolicy(taskId: string, policy: QualityPolicy): Promise<QualityPolicy> {
    const parsed = qualityPolicySchema.parse(policy);
    const timestamp = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO quality_policies(task_id,policy,created_at,updated_at) VALUES (?,?,?,?)
         ON CONFLICT(task_id) DO UPDATE SET policy=excluded.policy,updated_at=excluded.updated_at`,
      )
      .run(taskId, JSON.stringify(parsed), timestamp, timestamp);
    return parsed;
  }

  async getEvaluationByRun(runId: string): Promise<QualityEvaluation | null> {
    const row = this.sqlite
      .prepare('SELECT * FROM quality_evaluations WHERE run_id=?')
      .get(runId) as Row | undefined;
    return row ? evaluationRow(row) : null;
  }

  async createEvaluation(
    input: Omit<QualityEvaluation, 'id' | 'createdAt'>,
    notification?: QualityNotificationDraft,
  ): Promise<QualityEvaluation> {
    return this.sqlite.transaction(() => {
      const existing = this.sqlite
        .prepare('SELECT * FROM quality_evaluations WHERE run_id=?')
        .get(input.runId) as Row | undefined;
      if (existing) return evaluationRow(existing);
      const latest = this.sqlite
        .prepare(
          'SELECT created_at FROM quality_evaluations WHERE task_id=? ORDER BY created_at DESC LIMIT 1',
        )
        .get(input.taskId) as Row | undefined;
      const createdAt = monotonicTimestamp(latest?.created_at);
      const id = randomUUID();
      this.sqlite
        .prepare(
          `INSERT INTO quality_evaluations(id,task_id,run_id,status,profile,issues,created_at)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.taskId,
          input.runId,
          input.status,
          JSON.stringify(input.profile),
          JSON.stringify(input.issues),
          createdAt,
        );
      const evaluation = qualityEvaluationSchema.parse({ id, createdAt, ...input });
      const policyRow = this.sqlite
        .prepare('SELECT policy FROM quality_policies WHERE task_id=?')
        .get(input.taskId) as Row | undefined;
      const policy = policyRow
        ? qualityPolicySchema.parse(JSON.parse(String(policyRow.policy)))
        : defaultQualityPolicy;
      const decisions = this.alerts.evaluate(
        evaluation,
        policy,
        notification?.type === 'quality.issue.detected',
      );
      if (notification?.type === 'quality.issue.detected') {
        notification = decisions.eligible.length
          ? {
              ...notification,
              payload: {
                taskId: input.taskId,
                runId: input.runId,
                status: input.status,
                issueCount: decisions.eligible.length,
                issueKinds: [...new Set(decisions.eligible.map((issue) => issue.kind))],
                alertIds: decisions.alertIds,
              },
            }
          : undefined;
      }
      this.upsertTaskState(input.taskId, input.profile.recordCount > 0, notification, createdAt);
      if (notification) {
        this.createNotification(evaluation, notification);
      }
      return evaluation;
    })();
  }

  async hasEverNonEmpty(taskId: string): Promise<boolean> {
    const row = this.sqlite
      .prepare('SELECT ever_nonempty FROM quality_task_state WHERE task_id=?')
      .get(taskId) as Row | undefined;
    return Number(row?.ever_nonempty ?? 0) === 1;
  }

  async hasOpenIssue(taskId: string): Promise<boolean> {
    const row = this.sqlite
      .prepare('SELECT open_issue FROM quality_task_state WHERE task_id=?')
      .get(taskId) as Row | undefined;
    return Number(row?.open_issue ?? 0) === 1;
  }

  async getPendingNotificationByRun(runId: string): Promise<QualityNotification | null> {
    const row = this.sqlite
      .prepare('SELECT * FROM quality_notifications WHERE run_id=? AND delivered_at IS NULL')
      .get(runId) as Row | undefined;
    return row ? notificationRow(row) : null;
  }

  async markNotificationDelivered(eventId: string): Promise<void> {
    this.sqlite
      .prepare(
        'UPDATE quality_notifications SET delivered_at=? WHERE event_id=? AND delivered_at IS NULL',
      )
      .run(new Date().toISOString(), eventId);
  }

  async listEvaluations(taskId: string, limit = 50): Promise<QualityEvaluation[]> {
    return (
      this.sqlite
        .prepare(
          `SELECT * FROM quality_evaluations WHERE task_id=?
           ORDER BY created_at DESC,id DESC LIMIT ?`,
        )
        .all(taskId, Math.min(Math.max(limit, 1), 500)) as Row[]
    ).map(evaluationRow);
  }

  async listBaselineProfiles(taskId: string, limit: number): Promise<QualityProfile[]> {
    return (
      this.sqlite
        .prepare(
          `SELECT profile FROM quality_evaluations
           WHERE task_id=? AND status IN ('unknown','healthy','warning')
           ORDER BY created_at DESC,id DESC LIMIT ?`,
        )
        .all(taskId, Math.min(Math.max(limit, 1), 20)) as Row[]
    ).map((row) => qualityProfileSchema.parse(JSON.parse(String(row.profile))));
  }

  async getHealth(taskId: string): Promise<TaskHealth> {
    const latest = (await this.listEvaluations(taskId, 1))[0];
    const policy = await this.getPolicy(taskId);
    const count = Number(
      (
        this.sqlite
          .prepare(
            `SELECT COUNT(*) AS count FROM quality_evaluations
             WHERE task_id=? AND status IN ('unknown','healthy','warning')`,
          )
          .get(taskId) as Row
      ).count,
    );
    const baselineReady = count >= policy.minimumBaselineRuns;
    return {
      taskId,
      status:
        latest?.status === 'healthy' && !baselineReady ? 'unknown' : (latest?.status ?? 'unknown'),
      latestRunId: latest?.runId ?? null,
      issues: latest?.issues ?? [],
      baselineReady,
      updatedAt: latest?.createdAt ?? null,
    };
  }

  getHealthMany(taskIds: readonly string[]): Promise<TaskHealth[]> {
    return Promise.all([...new Set(taskIds)].map((taskId) => this.getHealth(taskId)));
  }

  async deleteTask(taskId: string): Promise<void> {
    this.sqlite.transaction(() => {
      this.sqlite.prepare('DELETE FROM quality_alerts WHERE task_id=?').run(taskId);
      this.sqlite.prepare('DELETE FROM quality_rule_state WHERE task_id=?').run(taskId);
      this.sqlite.prepare('DELETE FROM quality_evaluations WHERE task_id=?').run(taskId);
      this.sqlite.prepare('DELETE FROM quality_policies WHERE task_id=?').run(taskId);
      this.sqlite.prepare('DELETE FROM quality_task_state WHERE task_id=?').run(taskId);
    })();
  }

  async listAlerts(taskId: string, limit = 50) {
    return this.alerts.list(taskId, limit);
  }
  async listAlertsPage(taskId: string, cursor?: string, limit = 50) {
    return this.alerts.listPage(taskId, cursor, limit);
  }
  async dismissAlert(taskId: string, alertId: string) {
    return this.alerts.dismiss(taskId, alertId);
  }
  async listAlertRuns(taskId: string, alertId: string, cursor?: string, limit = 50) {
    return this.alerts.listRuns(taskId, alertId, cursor, limit);
  }

  private upsertTaskState(
    taskId: string,
    nonEmpty: boolean,
    notification: QualityNotificationDraft | undefined,
    timestamp: string,
  ): void {
    const openIssue = notification?.type === 'quality.issue.detected';
    const closesIssue = notification?.type === 'quality.recovered';
    this.sqlite
      .prepare(
        `INSERT INTO quality_task_state(task_id,ever_nonempty,open_issue,updated_at)
         VALUES (?,?,?,?)
         ON CONFLICT(task_id) DO UPDATE SET
           ever_nonempty=MAX(quality_task_state.ever_nonempty,excluded.ever_nonempty),
           open_issue=CASE
             WHEN ?=1 THEN 1
             WHEN ?=1 THEN 0
             ELSE quality_task_state.open_issue
           END,
           updated_at=excluded.updated_at`,
      )
      .run(
        taskId,
        Number(nonEmpty),
        Number(openIssue),
        timestamp,
        Number(openIssue),
        Number(closesIssue),
      );
  }

  private createNotification(
    evaluation: QualityEvaluation,
    notification: QualityNotificationDraft,
  ): void {
    const eventId = randomUUID();
    this.sqlite
      .prepare(
        `INSERT INTO quality_notifications(
           event_id,evaluation_id,task_id,run_id,event_type,severity,payload,occurred_at,delivered_at
         ) VALUES (?,?,?,?,?,?,?,?,NULL)`,
      )
      .run(
        eventId,
        evaluation.id,
        evaluation.taskId,
        evaluation.runId,
        notification.type,
        notification.severity,
        JSON.stringify(notification.payload),
        evaluation.createdAt,
      );
    this.sqlite
      .prepare(
        `INSERT INTO platform_events(
           id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
         ) VALUES (?, ?, 1, 'monitoring', 'task-health', ?, ?, ?)`,
      )
      .run(
        eventId,
        notification.type,
        evaluation.taskId,
        JSON.stringify(notification.payload),
        evaluation.createdAt,
      );
  }
}

function evaluationRow(row: Row): QualityEvaluation {
  return qualityEvaluationSchema.parse({
    id: String(row.id),
    taskId: String(row.task_id),
    runId: String(row.run_id),
    status: String(row.status),
    profile: JSON.parse(String(row.profile)),
    issues: JSON.parse(String(row.issues)),
    createdAt: String(row.created_at),
  });
}

function notificationRow(row: Row): QualityNotification {
  return {
    eventId: String(row.event_id),
    evaluationId: String(row.evaluation_id),
    taskId: String(row.task_id),
    runId: String(row.run_id),
    type: String(row.event_type) as QualityNotification['type'],
    severity: String(row.severity) as QualityNotification['severity'],
    payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
    occurredAt: String(row.occurred_at),
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function monotonicTimestamp(previous: unknown): string {
  const previousTime = typeof previous === 'string' ? Date.parse(previous) : Number.NaN;
  return new Date(
    Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0),
  ).toISOString();
}
