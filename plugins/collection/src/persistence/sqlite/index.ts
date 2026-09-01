import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  normalizeCrawlPlan,
  type CrawlRun,
  type RuleRepairProposal,
  type RunLogEntry,
  type RunRequestEntry,
} from '@zhiyun/shared';
import type {
  ActiveRuleRecord,
  CollectionRepository,
  CollectionTask,
  CollectionTaskCreate,
  CollectionTaskDetail,
  CollectionTaskUpdate,
  RuleRecord,
  RuleVersionRecord,
  RunCompletionInput,
} from '../../contracts/index.js';
import {
  collectionSqliteMigration001,
  collectionSqliteMigration002,
} from '../../migrations/sqlite/index.js';

type SqlRow = Record<string, unknown>;
const MIGRATIONS = [
  { id: '001-initial', sql: collectionSqliteMigration001, version: '1.0.0' },
  { id: '002-task-origin', sql: collectionSqliteMigration002, version: '1.1.0' },
] as const;

export class SqliteCollectionRepository implements CollectionRepository {
  private readonly sqlite: Database.Database;

  constructor(filePath: string) {
    this.sqlite = new Database(filePath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
  }

  async migrate(): Promise<void> {
    for (const migration of MIGRATIONS) {
      const checksum = sha256(migration.sql);
      const existing = this.sqlite
        .prepare('SELECT checksum FROM plugin_migrations WHERE plugin_id=? AND migration_id=?')
        .get('collection', migration.id) as SqlRow | undefined;
      if (existing) {
        if (existing.checksum !== checksum) {
          throw new Error(`Migration checksum mismatch for collection:${migration.id}`);
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
             ) VALUES ('collection',?,?,?,?,?,'succeeded')`,
          )
          .run(
            migration.id,
            migration.version,
            checksum,
            now(),
            Math.max(0, Math.round(performance.now() - started)),
          );
      })();
    }
  }

  async close(): Promise<void> {
    if (this.sqlite.open) this.sqlite.close();
  }

  async createTask(input: CollectionTaskCreate): Promise<CollectionTask> {
    return this.sqlite.transaction(() => {
      const id = randomUUID();
      const timestamp = now();
      this.sqlite
        .prepare(
          `INSERT INTO tasks(
             id,name,start_url,instruction,status,schedule,request_settings,browser_settings,
             pagination,output_settings,credential_bindings,dataset_settings,retention_policy,
             network_policy,origin,revision,created_at,updated_at
           ) VALUES (?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,1,?,?)`,
        )
        .run(
          id,
          input.name,
          input.startUrl,
          input.instruction,
          json(input.schedule),
          json(input.requestSettings),
          json(input.browserSettings),
          json(input.pagination),
          json(input.outputSettings),
          json(input.credentialBindings),
          json(input.datasetSettings),
          json(input.retentionPolicy),
          json(input.networkPolicy),
          json({ kind: 'manual' }),
          timestamp,
          timestamp,
        );
      syncSchedule(this.sqlite, id, input.schedule, timestamp);
      appendEvent(this.sqlite, 'collection.task.created', 'task', id, { revision: 1 });
      return taskRow(this.sqlite.prepare('SELECT * FROM tasks WHERE id=?').get(id) as SqlRow);
    })();
  }

  async createTaskWithInitialRule(
    input: Parameters<CollectionRepository['createTaskWithInitialRule']>[0],
  ): Promise<{ taskId: string; ruleId: string; versionId: string }> {
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.prepare('SELECT id FROM tasks WHERE id=?').get(input.taskId) as
        SqlRow | undefined;
      if (existing) {
        const rule = this.sqlite
          .prepare('SELECT id,active_version_id FROM rules WHERE id=? AND task_id=?')
          .get(input.ruleId, input.taskId) as SqlRow | undefined;
        const version = this.sqlite
          .prepare('SELECT id FROM rule_versions WHERE id=? AND rule_id=?')
          .get(input.versionId, input.ruleId) as SqlRow | undefined;
        if (!rule || rule.active_version_id !== input.versionId || !version) {
          throw new Error('Deterministic AI Task identifiers conflict with existing data');
        }
        return {
          taskId: input.taskId,
          ruleId: input.ruleId,
          versionId: input.versionId,
        };
      }
      const timestamp = now();
      const task = input.task;
      this.sqlite
        .prepare(
          `INSERT INTO tasks(
             id,name,start_url,instruction,status,schedule,request_settings,browser_settings,
             pagination,output_settings,credential_bindings,dataset_settings,retention_policy,
             network_policy,origin,revision,created_at,updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
        )
        .run(
          input.taskId,
          task.name,
          task.startUrl,
          task.instruction,
          input.status ?? 'ready',
          json(task.schedule),
          json(task.requestSettings),
          json(task.browserSettings),
          json(task.pagination),
          json(task.outputSettings),
          json(task.credentialBindings),
          json(task.datasetSettings),
          json(task.retentionPolicy),
          json(task.networkPolicy),
          json(input.origin ?? { kind: 'ai' }),
          timestamp,
          timestamp,
        );
      syncSchedule(this.sqlite, input.taskId, task.schedule, timestamp);
      this.sqlite
        .prepare(
          `INSERT INTO rules(id,task_id,name,active_version_id,created_at,updated_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(input.ruleId, input.taskId, input.ruleName, input.versionId, timestamp, timestamp);
      this.sqlite
        .prepare(
          `INSERT INTO rule_versions(id,rule_id,version,definition,generated_by,created_at)
           VALUES (?,?,1,?,?,?)`,
        )
        .run(
          input.versionId,
          input.ruleId,
          json(normalizeCrawlPlan(input.definition)),
          input.generatedBy ?? 'ai',
          timestamp,
        );
      appendEvent(this.sqlite, 'collection.task.created', 'task', input.taskId, {
        revision: 1,
        generatedBy: input.generatedBy ?? 'ai',
      });
      appendEvent(this.sqlite, 'collection.rule.created', 'rule', input.ruleId, {
        taskId: input.taskId,
        version: 1,
        generatedBy: input.generatedBy ?? 'ai',
      });
      return { taskId: input.taskId, ruleId: input.ruleId, versionId: input.versionId };
    })();
  }

  async listTasks(cursor?: string, limit = 100) {
    const pageSize = Math.min(Math.max(limit, 1), 500);
    const decoded = cursor ? decodeCursor(cursor) : null;
    const rows = decoded
      ? (this.sqlite
          .prepare(
            `SELECT * FROM tasks WHERE updated_at<? OR (updated_at=? AND id<?)
             ORDER BY updated_at DESC,id DESC LIMIT ?`,
          )
          .all(decoded.at, decoded.at, decoded.id, pageSize + 1) as SqlRow[])
      : (this.sqlite
          .prepare('SELECT * FROM tasks ORDER BY updated_at DESC,id DESC LIMIT ?')
          .all(pageSize + 1) as SqlRow[]);
    const items = rows.slice(0, pageSize).map(taskRow);
    return {
      items,
      nextCursor:
        rows.length > pageSize ? encodeCursor(items.at(-1)!.updatedAt, items.at(-1)!.id) : null,
    };
  }

  async getTask(id: string): Promise<CollectionTaskDetail | null> {
    const row = this.sqlite.prepare('SELECT * FROM tasks WHERE id=?').get(id) as SqlRow | undefined;
    if (!row) return null;
    return { ...taskRow(row), activeRule: activeRule(this.sqlite, id) };
  }

  async updateTask(
    id: string,
    input: CollectionTaskUpdate,
    expectedRevision: number,
  ): Promise<CollectionTask | null> {
    return this.sqlite.transaction(() => {
      const row = this.sqlite.prepare('SELECT * FROM tasks WHERE id=?').get(id) as
        SqlRow | undefined;
      if (!row || Number(row.revision) !== expectedRevision) return null;
      const current = taskRow(row);
      const merged = { ...current, ...input } as CollectionTask;
      const timestamp = now();
      const result = this.sqlite
        .prepare(
          `UPDATE tasks SET
             name=?,start_url=?,instruction=?,schedule=?,request_settings=?,browser_settings=?,
             pagination=?,output_settings=?,credential_bindings=?,dataset_settings=?,
             retention_policy=?,network_policy=?,revision=revision+1,updated_at=?
           WHERE id=? AND revision=?`,
        )
        .run(
          merged.name,
          merged.startUrl,
          merged.instruction,
          json(merged.schedule),
          json(merged.requestSettings),
          json(merged.browserSettings),
          json(merged.pagination),
          json(merged.outputSettings),
          json(merged.credentialBindings),
          json(merged.datasetSettings),
          json(merged.retentionPolicy),
          json(merged.networkPolicy),
          timestamp,
          id,
          expectedRevision,
        );
      if (result.changes !== 1) return null;
      if (input.schedule) syncSchedule(this.sqlite, id, merged.schedule, timestamp);
      appendEvent(this.sqlite, 'collection.task.updated', 'task', id, {
        revision: expectedRevision + 1,
      });
      return taskRow(this.sqlite.prepare('SELECT * FROM tasks WHERE id=?').get(id) as SqlRow);
    })();
  }

  async deleteTask(id: string): Promise<boolean> {
    return this.sqlite.transaction(() => {
      const result = this.sqlite.prepare('DELETE FROM tasks WHERE id=?').run(id);
      if (result.changes === 0) return false;
      appendEvent(this.sqlite, 'collection.task.deleted', 'task', id, {});
      return true;
    })();
  }

  async setTaskBrowserSettings(
    id: string,
    settings: CollectionTask['browserSettings'],
  ): Promise<void> {
    this.sqlite
      .prepare('UPDATE tasks SET browser_settings=?,revision=revision+1,updated_at=? WHERE id=?')
      .run(json(settings), now(), id);
  }

  async listRules(taskId: string): Promise<Array<RuleRecord & { versions: RuleVersionRecord[] }>> {
    const rules = this.sqlite
      .prepare('SELECT * FROM rules WHERE task_id=? ORDER BY created_at DESC')
      .all(taskId) as SqlRow[];
    const versions = this.sqlite.prepare(
      'SELECT * FROM rule_versions WHERE rule_id=? ORDER BY version DESC',
    );
    return rules.map((row) => ({
      ...ruleRow(row),
      versions: (versions.all(row.id) as SqlRow[]).map(ruleVersionRow),
    }));
  }

  async createRule(
    taskId: string,
    name: string,
    definition: Parameters<CollectionRepository['createRule']>[2],
    generatedBy: Parameters<CollectionRepository['createRule']>[3],
  ) {
    return this.sqlite.transaction(() => {
      const timestamp = now();
      const ruleId = randomUUID();
      const versionId = randomUUID();
      this.sqlite
        .prepare(
          'INSERT INTO rules(id,task_id,name,active_version_id,created_at,updated_at) VALUES (?,?,?,NULL,?,?)',
        )
        .run(ruleId, taskId, name, timestamp, timestamp);
      this.sqlite
        .prepare(
          `INSERT INTO rule_versions(id,rule_id,version,definition,generated_by,created_at)
           VALUES (?,?,1,?,?,?)`,
        )
        .run(versionId, ruleId, json(normalizeCrawlPlan(definition)), generatedBy, timestamp);
      this.sqlite.prepare('UPDATE rules SET active_version_id=? WHERE id=?').run(versionId, ruleId);
      this.sqlite
        .prepare("UPDATE tasks SET status='ready',updated_at=? WHERE id=?")
        .run(timestamp, taskId);
      appendEvent(this.sqlite, 'collection.rule.created', 'rule', ruleId, { taskId, version: 1 });
      return {
        rule: ruleRow(this.sqlite.prepare('SELECT * FROM rules WHERE id=?').get(ruleId) as SqlRow),
        version: ruleVersionRow(
          this.sqlite.prepare('SELECT * FROM rule_versions WHERE id=?').get(versionId) as SqlRow,
        ),
      };
    })();
  }

  async createRuleVersion(
    taskId: string,
    ruleId: string,
    definition: Parameters<CollectionRepository['createRuleVersion']>[2],
    generatedBy: Parameters<CollectionRepository['createRuleVersion']>[3],
  ): Promise<RuleVersionRecord | null> {
    return this.sqlite.transaction(() => {
      const rule = this.sqlite
        .prepare('SELECT * FROM rules WHERE id=? AND task_id=?')
        .get(ruleId, taskId) as SqlRow | undefined;
      if (!rule) return null;
      const current = this.sqlite
        .prepare('SELECT MAX(version) AS version FROM rule_versions WHERE rule_id=?')
        .get(ruleId) as SqlRow;
      const version = Number(current.version ?? 0) + 1;
      const id = randomUUID();
      const timestamp = now();
      this.sqlite
        .prepare(
          `INSERT INTO rule_versions(id,rule_id,version,definition,generated_by,created_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .run(id, ruleId, version, json(normalizeCrawlPlan(definition)), generatedBy, timestamp);
      this.sqlite
        .prepare('UPDATE rules SET active_version_id=?,updated_at=? WHERE id=?')
        .run(id, timestamp, ruleId);
      appendEvent(this.sqlite, 'collection.rule.version-created', 'rule', ruleId, {
        taskId,
        version,
      });
      return ruleVersionRow(
        this.sqlite.prepare('SELECT * FROM rule_versions WHERE id=?').get(id) as SqlRow,
      );
    })();
  }

  async getActiveRule(taskId: string): Promise<ActiveRuleRecord | null> {
    return activeRule(this.sqlite, taskId);
  }

  async createRun(taskId: string): Promise<CrawlRun> {
    return this.sqlite.transaction(() => {
      const id = randomUUID();
      const timestamp = now();
      this.sqlite
        .prepare(
          `INSERT INTO runs(
             id,task_id,status,request_count,record_count,browser_used,ai_used,phase,progress,
             dataset_stats,delivery_status,warning_count,metadata,created_at
           ) VALUES (?,?,'queued',0,0,0,0,'queued',0,?,'idle',0,'{}',?)`,
        )
        .run(id, taskId, json(emptyStats()), timestamp);
      appendEvent(this.sqlite, 'collection.run.queued', 'run', id, { taskId });
      return runRow(this.sqlite.prepare('SELECT * FROM runs WHERE id=?').get(id) as SqlRow);
    })();
  }

  async listRuns(taskId: string): Promise<CrawlRun[]> {
    return (
      this.sqlite
        .prepare('SELECT * FROM runs WHERE task_id=? ORDER BY created_at DESC,id DESC')
        .all(taskId) as SqlRow[]
    ).map(runRow);
  }

  async getRun(id: string): Promise<CrawlRun | null> {
    const row = this.sqlite.prepare('SELECT * FROM runs WHERE id=?').get(id) as SqlRow | undefined;
    return row ? runRow(row) : null;
  }

  async startRun(runId: string, taskId: string, allowRecovery = false): Promise<boolean> {
    return this.sqlite.transaction(() => {
      const timestamp = now();
      const result = this.sqlite
        .prepare(
          `UPDATE runs SET status='running',started_at=?,finished_at=NULL,phase='starting',
             progress=0.02,error=NULL,error_code=NULL
           WHERE id=? AND task_id=?
             AND (status IN ('queued','failed') OR (?=1 AND status='running'))`,
        )
        .run(timestamp, runId, taskId, allowRecovery ? 1 : 0);
      if (result.changes !== 1) return false;
      this.sqlite
        .prepare("UPDATE tasks SET status='running',updated_at=? WHERE id=?")
        .run(timestamp, taskId);
      appendEvent(this.sqlite, 'collection.run.started', 'run', runId, { taskId });
      return true;
    })();
  }

  async markRunPersisting(runId: string, taskId: string): Promise<boolean> {
    const result = this.sqlite
      .prepare(
        `UPDATE runs SET phase='persisting',progress=MAX(progress,0.9)
         WHERE id=? AND task_id=? AND status='running' AND cancel_requested_at IS NULL`,
      )
      .run(runId, taskId);
    return result.changes === 1;
  }

  async completeRun(
    runId: string,
    taskId: string,
    input: RunCompletionInput,
  ): Promise<CrawlRun | null> {
    return this.sqlite.transaction(() => {
      const existing = this.sqlite.prepare('SELECT * FROM runs WHERE id=?').get(runId) as
        SqlRow | undefined;
      if (existing?.status === 'succeeded') return runRow(existing);
      const timestamp = now();
      const result = this.sqlite
        .prepare(
          `UPDATE runs SET
             status='succeeded',finished_at=?,request_count=?,record_count=?,browser_used=?,
             ai_used=?,phase='completed',progress=1,dataset_stats=?,dataset_id=?,
             dataset_snapshot_id=?,metadata=?
           WHERE id=? AND task_id=? AND status='running' AND phase='persisting'
             AND cancel_requested_at IS NULL`,
        )
        .run(
          timestamp,
          input.requestCount,
          input.recordCount,
          Number(input.browserUsed),
          Number(input.aiUsed),
          json(input.datasetStats),
          input.datasetId,
          input.datasetSnapshotId,
          json({
            ...input.metadata,
            datasetId: input.datasetId,
            datasetSnapshotId: input.datasetSnapshotId,
          }),
          runId,
          taskId,
        );
      if (result.changes !== 1) return null;
      this.sqlite
        .prepare("UPDATE tasks SET status='succeeded',updated_at=? WHERE id=?")
        .run(timestamp, taskId);
      appendEvent(this.sqlite, 'collection.run.succeeded', 'run', runId, {
        taskId,
        datasetId: input.datasetId,
        datasetSnapshotId: input.datasetSnapshotId,
      });
      return runRow(this.sqlite.prepare('SELECT * FROM runs WHERE id=?').get(runId) as SqlRow);
    })();
  }

  async failRun(
    runId: string,
    taskId: string,
    error: string,
    code: string,
    finalFailure = false,
  ): Promise<CrawlRun | null> {
    return this.sqlite.transaction(() => {
      const timestamp = now();
      const result = this.sqlite
        .prepare(
          `UPDATE runs SET
             status='failed',finished_at=?,error=?,error_code=?,phase='failed',progress=1
           WHERE id=? AND task_id=? AND status IN ('queued','running')`,
        )
        .run(timestamp, error, code, runId, taskId);
      if (result.changes !== 1) return null;
      this.sqlite
        .prepare("UPDATE tasks SET status='failed',updated_at=? WHERE id=?")
        .run(timestamp, taskId);
      appendEvent(this.sqlite, 'collection.run.failed', 'run', runId, {
        taskId,
        code,
        finalFailure,
      });
      return runRow(this.sqlite.prepare('SELECT * FROM runs WHERE id=?').get(runId) as SqlRow);
    })();
  }

  async requestRunCancellation(runId: string): Promise<CrawlRun | null> {
    return this.sqlite.transaction(() => {
      const row = this.sqlite.prepare('SELECT * FROM runs WHERE id=?').get(runId) as
        SqlRow | undefined;
      if (!row || !['queued', 'running'].includes(String(row.status))) return null;
      if (row.status === 'queued') return cancelRunSync(this.sqlite, row);
      const timestamp = now();
      this.sqlite
        .prepare("UPDATE runs SET cancel_requested_at=?,phase='canceling' WHERE id=?")
        .run(timestamp, runId);
      appendEvent(this.sqlite, 'collection.run.cancel-requested', 'run', runId, {
        taskId: row.task_id,
      });
      return runRow(this.sqlite.prepare('SELECT * FROM runs WHERE id=?').get(runId) as SqlRow);
    })();
  }

  async cancelRun(runId: string): Promise<CrawlRun | null> {
    return this.sqlite.transaction(() => {
      const row = this.sqlite.prepare('SELECT * FROM runs WHERE id=?').get(runId) as
        SqlRow | undefined;
      return row && ['queued', 'running'].includes(String(row.status))
        ? cancelRunSync(this.sqlite, row)
        : null;
    })();
  }

  async appendRunLog(
    entry: Omit<RunLogEntry, 'id' | 'sequence' | 'createdAt'>,
  ): Promise<RunLogEntry> {
    return this.sqlite.transaction(() => {
      const current = this.sqlite
        .prepare('SELECT MAX(sequence) AS sequence FROM run_logs WHERE run_id=?')
        .get(entry.runId) as SqlRow;
      const sequence = Number(current.sequence ?? 0) + 1;
      const id = randomUUID();
      const timestamp = now();
      this.sqlite
        .prepare(
          `INSERT INTO run_logs(
             id,run_id,sequence,level,phase,message,url,error_code,metadata,created_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          entry.runId,
          sequence,
          entry.level,
          entry.phase,
          entry.message,
          entry.url,
          entry.errorCode,
          json(entry.metadata),
          timestamp,
        );
      const progress = entry.metadata.progress;
      this.sqlite
        .prepare(
          `UPDATE runs SET phase=?,
             progress=CASE WHEN ? IS NULL THEN progress ELSE ? END,
             warning_count=warning_count+? WHERE id=?`,
        )
        .run(
          entry.phase,
          typeof progress === 'number' ? progress : null,
          typeof progress === 'number' ? progress : null,
          entry.level === 'warn' ? 1 : 0,
          entry.runId,
        );
      return runLogRow(this.sqlite.prepare('SELECT * FROM run_logs WHERE id=?').get(id) as SqlRow);
    })();
  }

  async listRunLogs(runId: string, afterSequence = 0, limit = 200): Promise<RunLogEntry[]> {
    return (
      this.sqlite
        .prepare(
          `SELECT * FROM run_logs WHERE run_id=? AND sequence>?
           ORDER BY sequence LIMIT ?`,
        )
        .all(runId, afterSequence, Math.min(Math.max(limit, 1), 1_000)) as SqlRow[]
    ).map(runLogRow);
  }

  async appendRunRequest(
    entry: Omit<RunRequestEntry, 'id' | 'createdAt'>,
  ): Promise<RunRequestEntry> {
    const id = randomUUID();
    this.sqlite
      .prepare(
        `INSERT INTO run_requests(
           id,run_id,url,kind,status,status_code,duration_ms,error_code,error,created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        entry.runId,
        entry.url,
        entry.kind,
        entry.status,
        entry.statusCode,
        entry.durationMs,
        entry.errorCode,
        entry.error,
        now(),
      );
    return runRequestRow(
      this.sqlite.prepare('SELECT * FROM run_requests WHERE id=?').get(id) as SqlRow,
    );
  }

  async listRunRequests(runId: string, cursor?: string, limit = 100) {
    const pageSize = Math.min(Math.max(limit, 1), 500);
    const decoded = cursor ? decodeCursor(cursor) : null;
    const rows = decoded
      ? (this.sqlite
          .prepare(
            `SELECT * FROM run_requests WHERE run_id=?
               AND (created_at>? OR (created_at=? AND id>?))
             ORDER BY created_at,id LIMIT ?`,
          )
          .all(runId, decoded.at, decoded.at, decoded.id, pageSize + 1) as SqlRow[])
      : (this.sqlite
          .prepare('SELECT * FROM run_requests WHERE run_id=? ORDER BY created_at,id LIMIT ?')
          .all(runId, pageSize + 1) as SqlRow[]);
    const items = rows.slice(0, pageSize).map(runRequestRow);
    return {
      items,
      nextCursor:
        rows.length > pageSize ? encodeCursor(items.at(-1)!.createdAt, items.at(-1)!.id) : null,
    };
  }

  async listScheduledTasks() {
    const rows = this.sqlite
      .prepare('SELECT * FROM task_schedules ORDER BY task_id')
      .all() as SqlRow[];
    return rows.map((row) => ({
      id: String(row.task_id),
      schedule: {
        mode: 'cron' as const,
        cron: String(row.cron),
        timezone: String(row.timezone),
        misfirePolicy: row.misfire_policy as 'skip' | 'run-once',
      },
      lastTriggeredAt: row.last_triggered_at ? String(row.last_triggered_at) : null,
      updatedAt: String(row.updated_at),
    }));
  }

  async markScheduleTriggered(taskId: string, triggeredAt = now()): Promise<void> {
    this.sqlite
      .prepare('UPDATE task_schedules SET last_triggered_at=?,updated_at=? WHERE task_id=?')
      .run(triggeredAt, now(), taskId);
  }

  async createRuleRepairProposal(
    input: Parameters<CollectionRepository['createRuleRepairProposal']>[0],
  ): Promise<RuleRepairProposal> {
    const id = randomUUID();
    this.sqlite
      .prepare(
        `INSERT INTO rule_repair_proposals(
           id,task_id,rule_id,run_id,definition,explanation,status,created_at
         ) VALUES (?,?,?,?,?,?,'pending',?)`,
      )
      .run(
        id,
        input.taskId,
        input.ruleId,
        input.runId,
        json(normalizeCrawlPlan(input.definition)),
        input.explanation,
        now(),
      );
    return repairProposalRow(
      this.sqlite.prepare('SELECT * FROM rule_repair_proposals WHERE id=?').get(id) as SqlRow,
    );
  }

  async listRuleRepairProposals(ruleId: string): Promise<RuleRepairProposal[]> {
    return (
      this.sqlite
        .prepare('SELECT * FROM rule_repair_proposals WHERE rule_id=? ORDER BY created_at DESC')
        .all(ruleId) as SqlRow[]
    ).map(repairProposalRow);
  }

  async updateRuleRepairProposal(
    id: string,
    status: RuleRepairProposal['status'],
  ): Promise<RuleRepairProposal | null> {
    const result = this.sqlite
      .prepare('UPDATE rule_repair_proposals SET status=? WHERE id=?')
      .run(status, id);
    if (result.changes !== 1) return null;
    return repairProposalRow(
      this.sqlite.prepare('SELECT * FROM rule_repair_proposals WHERE id=?').get(id) as SqlRow,
    );
  }

  async markRuleRepairProposalTested(id: string): Promise<RuleRepairProposal | null> {
    const result = this.sqlite
      .prepare('UPDATE rule_repair_proposals SET tested_at=? WHERE id=?')
      .run(now(), id);
    if (result.changes !== 1) return null;
    return repairProposalRow(
      this.sqlite.prepare('SELECT * FROM rule_repair_proposals WHERE id=?').get(id) as SqlRow,
    );
  }
}

function taskRow(row: SqlRow): CollectionTask {
  return {
    id: String(row.id),
    name: String(row.name),
    startUrl: String(row.start_url),
    instruction: String(row.instruction),
    status: row.status as CollectionTask['status'],
    schedule: JSON.parse(String(row.schedule)) as CollectionTask['schedule'],
    requestSettings: JSON.parse(String(row.request_settings)) as CollectionTask['requestSettings'],
    browserSettings: JSON.parse(String(row.browser_settings)) as CollectionTask['browserSettings'],
    pagination: JSON.parse(String(row.pagination)) as CollectionTask['pagination'],
    outputSettings: JSON.parse(String(row.output_settings)) as CollectionTask['outputSettings'],
    credentialBindings: JSON.parse(
      String(row.credential_bindings),
    ) as CollectionTask['credentialBindings'],
    datasetSettings: JSON.parse(String(row.dataset_settings)) as CollectionTask['datasetSettings'],
    retentionPolicy: JSON.parse(String(row.retention_policy)) as CollectionTask['retentionPolicy'],
    networkPolicy: JSON.parse(String(row.network_policy)) as CollectionTask['networkPolicy'],
    origin: JSON.parse(String(row.origin ?? '{"kind":"manual"}')) as CollectionTask['origin'],
    revision: Number(row.revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function ruleRow(row: SqlRow): RuleRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    name: String(row.name),
    activeVersionId: row.active_version_id ? String(row.active_version_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function ruleVersionRow(row: SqlRow): RuleVersionRecord {
  return {
    id: String(row.id),
    ruleId: String(row.rule_id),
    version: Number(row.version),
    definition: normalizeCrawlPlan(JSON.parse(String(row.definition))),
    generatedBy: row.generated_by as RuleVersionRecord['generatedBy'],
    createdAt: String(row.created_at),
  };
}

function activeRule(sqlite: Database.Database, taskId: string): ActiveRuleRecord | null {
  const row = sqlite
    .prepare(
      `SELECT r.*,v.id AS version_id,v.rule_id,v.version,v.definition,v.generated_by,
         v.created_at AS version_created_at
       FROM rules r JOIN rule_versions v ON v.id=r.active_version_id
       WHERE r.task_id=? LIMIT 1`,
    )
    .get(taskId) as SqlRow | undefined;
  if (!row) return null;
  return {
    rule: ruleRow(row),
    version: ruleVersionRow({
      id: row.version_id,
      rule_id: row.rule_id,
      version: row.version,
      definition: row.definition,
      generated_by: row.generated_by,
      created_at: row.version_created_at,
    }),
  };
}

function runRow(row: SqlRow): CrawlRun {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    status: row.status as CrawlRun['status'],
    startedAt: nullableString(row.started_at),
    finishedAt: nullableString(row.finished_at),
    requestCount: Number(row.request_count),
    recordCount: Number(row.record_count),
    browserUsed: Boolean(row.browser_used),
    aiUsed: Boolean(row.ai_used),
    error: nullableString(row.error),
    errorCode: nullableString(row.error_code),
    phase: String(row.phase),
    progress: Number(row.progress),
    cancelRequestedAt: nullableString(row.cancel_requested_at),
    datasetStats: JSON.parse(String(row.dataset_stats)) as CrawlRun['datasetStats'],
    deliveryStatus: row.delivery_status as CrawlRun['deliveryStatus'],
    warningCount: Number(row.warning_count),
    metadata: JSON.parse(String(row.metadata)) as Record<string, unknown>,
    createdAt: String(row.created_at),
  };
}

function runLogRow(row: SqlRow): RunLogEntry {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    sequence: Number(row.sequence),
    level: row.level as RunLogEntry['level'],
    phase: String(row.phase),
    message: String(row.message),
    url: nullableString(row.url),
    errorCode: nullableString(row.error_code),
    metadata: JSON.parse(String(row.metadata)) as Record<string, unknown>,
    createdAt: String(row.created_at),
  };
}

function runRequestRow(row: SqlRow): RunRequestEntry {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    url: String(row.url),
    kind: row.kind as RunRequestEntry['kind'],
    status: row.status as RunRequestEntry['status'],
    statusCode: row.status_code === null ? null : Number(row.status_code),
    durationMs: Number(row.duration_ms),
    errorCode: nullableString(row.error_code),
    error: nullableString(row.error),
    createdAt: String(row.created_at),
  };
}

function repairProposalRow(row: SqlRow): RuleRepairProposal {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    ruleId: String(row.rule_id),
    runId: nullableString(row.run_id),
    definition: normalizeCrawlPlan(JSON.parse(String(row.definition))),
    explanation: String(row.explanation),
    status: row.status as RuleRepairProposal['status'],
    testedAt: nullableString(row.tested_at),
    createdAt: String(row.created_at),
  };
}

function cancelRunSync(sqlite: Database.Database, row: SqlRow): CrawlRun {
  const timestamp = now();
  sqlite
    .prepare(
      `UPDATE runs SET
         status='canceled',finished_at=?,error='Canceled by user',error_code='CANCELED',
         phase='canceled',progress=1 WHERE id=?`,
    )
    .run(timestamp, row.id);
  sqlite
    .prepare("UPDATE tasks SET status='ready',updated_at=? WHERE id=?")
    .run(timestamp, row.task_id);
  appendEvent(sqlite, 'collection.run.canceled', 'run', String(row.id), {
    taskId: row.task_id,
  });
  return runRow(sqlite.prepare('SELECT * FROM runs WHERE id=?').get(row.id) as SqlRow);
}

function syncSchedule(
  sqlite: Database.Database,
  taskId: string,
  schedule: CollectionTask['schedule'],
  timestamp: string,
): void {
  if (schedule.mode !== 'cron' || !schedule.cron) {
    sqlite.prepare('DELETE FROM task_schedules WHERE task_id=?').run(taskId);
    return;
  }
  sqlite
    .prepare(
      `INSERT INTO task_schedules(
         task_id,cron,timezone,misfire_policy,last_triggered_at,updated_at
       ) VALUES (?,?,?,?,NULL,?)
       ON CONFLICT(task_id) DO UPDATE SET
         cron=excluded.cron,timezone=excluded.timezone,
         misfire_policy=excluded.misfire_policy,updated_at=excluded.updated_at`,
    )
    .run(taskId, schedule.cron, schedule.timezone, schedule.misfirePolicy, timestamp);
}

function appendEvent(
  sqlite: Database.Database,
  type: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
): void {
  sqlite
    .prepare(
      `INSERT INTO platform_events(
         id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
       ) VALUES (?,?,1,'collection',?,?,?,?)`,
    )
    .run(randomUUID(), type, aggregateType, aggregateId, json(payload), now());
}

function emptyStats() {
  return { added: 0, updated: 0, removed: 0, unchanged: 0, current: 0 };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function now(): string {
  return new Date().toISOString();
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify({ at, id })).toString('base64url');
}

function decodeCursor(cursor: string): { at: string; id: string } {
  const value = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as Record<string, unknown>;
  if (typeof value.at !== 'string' || typeof value.id !== 'string') {
    throw new Error('Invalid Collection cursor');
  }
  return { at: value.at, id: value.id };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
