import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
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
  monitoringPostgresMigration001,
  monitoringPostgresMigration002,
} from '../../migrations/postgres/index.js';

type Row = Record<string, unknown>;
const MIGRATIONS = [
  { id: '001-initial', version: '1.0.0', sql: monitoringPostgresMigration001 },
  { id: '002-durable-notifications', version: '1.1.0', sql: monitoringPostgresMigration002 },
] as const;

export class PostgresMonitoringRepository implements MonitoringRepository {
  private readonly sql: ReturnType<typeof postgres>;

  constructor(connectionString: string, maxConnections = 5) {
    this.sql = postgres(connectionString, { max: maxConnections });
  }

  async migrate(): Promise<void> {
    for (const migration of MIGRATIONS) {
      const checksum = sha256(migration.sql);
      const rows = await this.sql`
        SELECT checksum FROM plugin_migrations
        WHERE plugin_id='monitoring' AND migration_id=${migration.id}
      `;
      if (rows[0]) {
        if (rows[0].checksum !== checksum) {
          throw new Error(`Migration checksum mismatch for monitoring:${migration.id}`);
        }
        continue;
      }
      const started = performance.now();
      await this.sql.begin(async (transaction) => {
        await transaction.unsafe(migration.sql);
        await transaction`
          INSERT INTO plugin_migrations(
            plugin_id,migration_id,plugin_version,checksum,executed_at,duration_ms,result
          ) VALUES (
            'monitoring',${migration.id},${migration.version},${checksum},${new Date()},
            ${Math.max(0, Math.round(performance.now() - started))},'succeeded'
          )
        `;
      });
    }
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  async getPolicy(taskId: string): Promise<QualityPolicy> {
    const rows = await this.sql`SELECT policy FROM quality_policies WHERE task_id=${taskId}`;
    return rows[0] ? qualityPolicySchema.parse(rows[0].policy) : defaultQualityPolicy;
  }

  async upsertPolicy(taskId: string, policy: QualityPolicy): Promise<QualityPolicy> {
    const parsed = qualityPolicySchema.parse(policy);
    const timestamp = new Date();
    await this.sql`
      INSERT INTO quality_policies(task_id,policy,created_at,updated_at)
      VALUES (${taskId},${this.sql.json(jsonValue(parsed))},${timestamp},${timestamp})
      ON CONFLICT(task_id) DO UPDATE SET policy=excluded.policy,updated_at=excluded.updated_at
    `;
    return parsed;
  }

  async getEvaluationByRun(runId: string): Promise<QualityEvaluation | null> {
    const rows = await this.sql`SELECT * FROM quality_evaluations WHERE run_id=${runId}`;
    return rows[0] ? evaluationRow(rows[0] as Row) : null;
  }

  async createEvaluation(
    input: Omit<QualityEvaluation, 'id' | 'createdAt'>,
    notification?: QualityNotificationDraft,
  ): Promise<QualityEvaluation> {
    return this.sql.begin(async (transaction) => {
      await transaction`
        SELECT pg_advisory_xact_lock(hashtextextended(${`monitoring:${input.taskId}`},0))
      `;
      const existing = await transaction`
        SELECT * FROM quality_evaluations WHERE run_id=${input.runId}
      `;
      if (existing[0]) return evaluationRow(existing[0] as Row);
      const latest = await transaction`
        SELECT created_at FROM quality_evaluations
        WHERE task_id=${input.taskId} ORDER BY created_at DESC LIMIT 1
      `;
      const createdAt = new Date(monotonicTimestamp(latest[0]?.created_at));
      const rows = await transaction`
        INSERT INTO quality_evaluations(id,task_id,run_id,status,profile,issues,created_at)
        VALUES (
          ${randomUUID()},${input.taskId},${input.runId},${input.status},
          ${transaction.json(jsonValue(input.profile))},
          ${transaction.json(jsonValue(input.issues))},${createdAt}
        ) RETURNING *
      `;
      const evaluation = evaluationRow(rows[0] as Row);
      const opensIssue = notification?.type === 'quality.issue.detected';
      const closesIssue = notification?.type === 'quality.recovered';
      await transaction`
        INSERT INTO quality_task_state(task_id,ever_nonempty,open_issue,updated_at)
        VALUES (${input.taskId},${input.profile.recordCount > 0},${opensIssue},${createdAt})
        ON CONFLICT(task_id) DO UPDATE SET
          ever_nonempty=quality_task_state.ever_nonempty OR EXCLUDED.ever_nonempty,
          open_issue=CASE
            WHEN ${opensIssue} THEN TRUE
            WHEN ${closesIssue} THEN FALSE
            ELSE quality_task_state.open_issue
          END,
          updated_at=EXCLUDED.updated_at
      `;
      if (notification) {
        const eventId = randomUUID();
        await transaction`
          INSERT INTO quality_notifications(
            event_id,evaluation_id,task_id,run_id,event_type,severity,payload,occurred_at,delivered_at
          ) VALUES (
            ${eventId},${evaluation.id},${evaluation.taskId},${evaluation.runId},
            ${notification.type},${notification.severity},
            ${transaction.json(jsonValue(notification.payload))},${createdAt},NULL
          )
        `;
        await transaction`
          INSERT INTO platform_events(
            id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
          ) VALUES (
            ${eventId},${notification.type},1,'monitoring','task-health',${evaluation.taskId},
            ${transaction.json(jsonValue(notification.payload))},${createdAt}
          )
        `;
      }
      return evaluation;
    });
  }

  async hasEverNonEmpty(taskId: string): Promise<boolean> {
    const rows = await this.sql`
      SELECT ever_nonempty FROM quality_task_state WHERE task_id=${taskId}
    `;
    return rows[0]?.ever_nonempty === true;
  }

  async hasOpenIssue(taskId: string): Promise<boolean> {
    const rows = await this.sql`SELECT open_issue FROM quality_task_state WHERE task_id=${taskId}`;
    return rows[0]?.open_issue === true;
  }

  async getPendingNotificationByRun(runId: string): Promise<QualityNotification | null> {
    const rows = await this.sql`
      SELECT * FROM quality_notifications WHERE run_id=${runId} AND delivered_at IS NULL
    `;
    return rows[0] ? notificationRow(rows[0] as Row) : null;
  }

  async markNotificationDelivered(eventId: string): Promise<void> {
    await this.sql`
      UPDATE quality_notifications SET delivered_at=${new Date()}
      WHERE event_id=${eventId} AND delivered_at IS NULL
    `;
  }

  async listEvaluations(taskId: string, limit = 50): Promise<QualityEvaluation[]> {
    const rows = await this.sql`
      SELECT * FROM quality_evaluations WHERE task_id=${taskId}
      ORDER BY created_at DESC,id DESC LIMIT ${Math.min(Math.max(limit, 1), 500)}
    `;
    return rows.map((row) => evaluationRow(row as Row));
  }

  async listBaselineProfiles(taskId: string, limit: number): Promise<QualityProfile[]> {
    const rows = await this.sql`
      SELECT profile FROM quality_evaluations
      WHERE task_id=${taskId} AND status IN ('unknown','healthy','warning')
      ORDER BY created_at DESC,id DESC LIMIT ${Math.min(Math.max(limit, 1), 20)}
    `;
    return rows.map((row) => qualityProfileSchema.parse(row.profile));
  }

  async getHealth(taskId: string): Promise<TaskHealth> {
    const [latest, policy, counts] = await Promise.all([
      this.listEvaluations(taskId, 1),
      this.getPolicy(taskId),
      this.sql`
        SELECT COUNT(*)::int AS count FROM quality_evaluations
        WHERE task_id=${taskId} AND status IN ('unknown','healthy','warning')
      `,
    ]);
    const evaluation = latest[0];
    const baselineReady = Number(counts[0]?.count ?? 0) >= policy.minimumBaselineRuns;
    return {
      taskId,
      status:
        evaluation?.status === 'healthy' && !baselineReady
          ? 'unknown'
          : (evaluation?.status ?? 'unknown'),
      latestRunId: evaluation?.runId ?? null,
      issues: evaluation?.issues ?? [],
      baselineReady,
      updatedAt: evaluation?.createdAt ?? null,
    };
  }

  getHealthMany(taskIds: readonly string[]): Promise<TaskHealth[]> {
    return Promise.all([...new Set(taskIds)].map((taskId) => this.getHealth(taskId)));
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`DELETE FROM quality_evaluations WHERE task_id=${taskId}`;
      await transaction`DELETE FROM quality_policies WHERE task_id=${taskId}`;
      await transaction`DELETE FROM quality_task_state WHERE task_id=${taskId}`;
    });
  }
}

function evaluationRow(row: Row): QualityEvaluation {
  return qualityEvaluationSchema.parse({
    id: String(row.id),
    taskId: String(row.task_id),
    runId: String(row.run_id),
    status: String(row.status),
    profile: row.profile,
    issues: row.issues,
    createdAt: iso(row.created_at),
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
    payload: row.payload as Record<string, unknown>,
    occurredAt: iso(row.occurred_at),
  };
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function jsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function monotonicTimestamp(previous: unknown): string {
  const previousTime = previous instanceof Date ? previous.getTime() : Date.parse(String(previous));
  return new Date(
    Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0),
  ).toISOString();
}
