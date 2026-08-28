import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
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
import { collectionPostgresMigration001 } from '../../migrations/postgres/index.js';

type PgRow = Record<string, unknown>;
type PostgresClient = ReturnType<typeof postgres>;
type PgTransaction = postgres.TransactionSql;
const MIGRATION_ID = '001-initial';

export class PostgresCollectionRepository implements CollectionRepository {
  private readonly sql: PostgresClient;

  constructor(connectionString: string, maxConnections = 5) {
    this.sql = postgres(connectionString, { max: maxConnections });
  }

  async migrate(): Promise<void> {
    const checksum = sha256(collectionPostgresMigration001);
    const rows = await this.sql`
      SELECT checksum FROM plugin_migrations
      WHERE plugin_id='collection' AND migration_id=${MIGRATION_ID}
    `;
    if (rows[0]) {
      if (rows[0].checksum !== checksum) {
        throw new Error('Migration checksum mismatch for collection:001-initial');
      }
      return;
    }
    const started = performance.now();
    await this.sql.begin(async (transaction) => {
      await transaction.unsafe(collectionPostgresMigration001);
      await transaction`
        INSERT INTO plugin_migrations(
          plugin_id,migration_id,plugin_version,checksum,executed_at,duration_ms,result
        ) VALUES (
          'collection',${MIGRATION_ID},'1.0.0',${checksum},${new Date()},
          ${Math.max(0, Math.round(performance.now() - started))},'succeeded'
        )
      `;
    });
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  async createTask(input: CollectionTaskCreate): Promise<CollectionTask> {
    return this.sql.begin(async (transaction) => {
      const id = randomUUID();
      const timestamp = new Date();
      const rows = await transaction`
        INSERT INTO tasks(
          id,name,start_url,instruction,status,schedule,request_settings,browser_settings,
          pagination,output_settings,credential_bindings,dataset_settings,retention_policy,
          network_policy,revision,created_at,updated_at
        ) VALUES (
          ${id},${input.name},${input.startUrl},${input.instruction},'draft',
          ${transaction.json(jsonValue(input.schedule))},
          ${transaction.json(jsonValue(input.requestSettings))},
          ${transaction.json(jsonValue(input.browserSettings))},
          ${transaction.json(jsonValue(input.pagination))},
          ${transaction.json(jsonValue(input.outputSettings))},
          ${transaction.json(jsonValue(input.credentialBindings))},
          ${transaction.json(jsonValue(input.datasetSettings))},
          ${transaction.json(jsonValue(input.retentionPolicy))},
          ${transaction.json(jsonValue(input.networkPolicy))},1,${timestamp},${timestamp}
        ) RETURNING *
      `;
      await syncSchedule(transaction, id, input.schedule, timestamp);
      await appendEvent(transaction, 'collection.task.created', 'task', id, { revision: 1 });
      return taskRow(rows[0] as PgRow);
    });
  }

  async listTasks(cursor?: string, limit = 100) {
    const pageSize = Math.min(Math.max(limit, 1), 500);
    const decoded = cursor ? decodeCursor(cursor) : null;
    const rows = decoded
      ? await this.sql`
          SELECT * FROM tasks
          WHERE updated_at<${new Date(decoded.at)}
            OR (updated_at=${new Date(decoded.at)} AND id<${decoded.id})
          ORDER BY updated_at DESC,id DESC LIMIT ${pageSize + 1}
        `
      : await this.sql`
          SELECT * FROM tasks ORDER BY updated_at DESC,id DESC LIMIT ${pageSize + 1}
        `;
    const items = rows.slice(0, pageSize).map((row) => taskRow(row as PgRow));
    return {
      items,
      nextCursor:
        rows.length > pageSize ? encodeCursor(items.at(-1)!.updatedAt, items.at(-1)!.id) : null,
    };
  }

  async getTask(id: string): Promise<CollectionTaskDetail | null> {
    const rows = await this.sql`SELECT * FROM tasks WHERE id=${id}`;
    if (!rows[0]) return null;
    return { ...taskRow(rows[0] as PgRow), activeRule: await this.getActiveRule(id) };
  }

  async updateTask(
    id: string,
    input: CollectionTaskUpdate,
    expectedRevision: number,
  ): Promise<CollectionTask | null> {
    return this.sql.begin(async (transaction) => {
      const selected = await transaction`SELECT * FROM tasks WHERE id=${id} FOR UPDATE`;
      const row = selected[0] as PgRow | undefined;
      if (!row || Number(row.revision) !== expectedRevision) return null;
      const merged = { ...taskRow(row), ...input } as CollectionTask;
      const timestamp = new Date();
      const rows = await transaction`
        UPDATE tasks SET
          name=${merged.name},start_url=${merged.startUrl},instruction=${merged.instruction},
          schedule=${transaction.json(jsonValue(merged.schedule))},
          request_settings=${transaction.json(jsonValue(merged.requestSettings))},
          browser_settings=${transaction.json(jsonValue(merged.browserSettings))},
          pagination=${transaction.json(jsonValue(merged.pagination))},
          output_settings=${transaction.json(jsonValue(merged.outputSettings))},
          credential_bindings=${transaction.json(jsonValue(merged.credentialBindings))},
          dataset_settings=${transaction.json(jsonValue(merged.datasetSettings))},
          retention_policy=${transaction.json(jsonValue(merged.retentionPolicy))},
          network_policy=${transaction.json(jsonValue(merged.networkPolicy))},
          revision=revision+1,updated_at=${timestamp}
        WHERE id=${id} AND revision=${expectedRevision} RETURNING *
      `;
      if (!rows[0]) return null;
      if (input.schedule) await syncSchedule(transaction, id, merged.schedule, timestamp);
      await appendEvent(transaction, 'collection.task.updated', 'task', id, {
        revision: expectedRevision + 1,
      });
      return taskRow(rows[0] as PgRow);
    });
  }

  async deleteTask(id: string): Promise<boolean> {
    return this.sql.begin(async (transaction) => {
      const rows = await transaction`DELETE FROM tasks WHERE id=${id} RETURNING id`;
      if (rows.length === 0) return false;
      await appendEvent(transaction, 'collection.task.deleted', 'task', id, {});
      return true;
    });
  }

  async setTaskBrowserSettings(
    id: string,
    settings: CollectionTask['browserSettings'],
  ): Promise<void> {
    await this.sql`
      UPDATE tasks SET browser_settings=${this.sql.json(jsonValue(settings))},
        revision=revision+1,updated_at=${new Date()} WHERE id=${id}
    `;
  }

  async listRules(taskId: string): Promise<Array<RuleRecord & { versions: RuleVersionRecord[] }>> {
    const rules = await this.sql`
      SELECT * FROM rules WHERE task_id=${taskId} ORDER BY created_at DESC,id DESC
    `;
    const result: Array<RuleRecord & { versions: RuleVersionRecord[] }> = [];
    for (const row of rules) {
      const versions = await this.sql`
        SELECT * FROM rule_versions WHERE rule_id=${String(row.id)} ORDER BY version DESC
      `;
      result.push({
        ...ruleRow(row as PgRow),
        versions: versions.map((version) => ruleVersionRow(version as PgRow)),
      });
    }
    return result;
  }

  async createRule(
    taskId: string,
    name: string,
    definition: Parameters<CollectionRepository['createRule']>[2],
    generatedBy: Parameters<CollectionRepository['createRule']>[3],
  ) {
    return this.sql.begin(async (transaction) => {
      const timestamp = new Date();
      const ruleId = randomUUID();
      const versionId = randomUUID();
      await transaction`
        INSERT INTO rules(id,task_id,name,active_version_id,created_at,updated_at)
        VALUES (${ruleId},${taskId},${name},NULL,${timestamp},${timestamp})
      `;
      const versionRows = await transaction`
        INSERT INTO rule_versions(id,rule_id,version,definition,generated_by,created_at)
        VALUES (
          ${versionId},${ruleId},1,
          ${transaction.json(jsonValue(normalizeCrawlPlan(definition)))},${generatedBy},${timestamp}
        ) RETURNING *
      `;
      const ruleRows = await transaction`
        UPDATE rules SET active_version_id=${versionId} WHERE id=${ruleId} RETURNING *
      `;
      await transaction`
        UPDATE tasks SET status='ready',updated_at=${timestamp} WHERE id=${taskId}
      `;
      await appendEvent(transaction, 'collection.rule.created', 'rule', ruleId, {
        taskId,
        version: 1,
      });
      return {
        rule: ruleRow(ruleRows[0] as PgRow),
        version: ruleVersionRow(versionRows[0] as PgRow),
      };
    });
  }

  async createRuleVersion(
    taskId: string,
    ruleId: string,
    definition: Parameters<CollectionRepository['createRuleVersion']>[2],
    generatedBy: Parameters<CollectionRepository['createRuleVersion']>[3],
  ): Promise<RuleVersionRecord | null> {
    return this.sql.begin(async (transaction) => {
      const rules = await transaction`
        SELECT * FROM rules WHERE id=${ruleId} AND task_id=${taskId} FOR UPDATE
      `;
      if (!rules[0]) return null;
      const current = await transaction`
        SELECT COALESCE(MAX(version),0) AS version FROM rule_versions WHERE rule_id=${ruleId}
      `;
      const version = Number(current[0]?.version ?? 0) + 1;
      const timestamp = new Date();
      const rows = await transaction`
        INSERT INTO rule_versions(id,rule_id,version,definition,generated_by,created_at)
        VALUES (
          ${randomUUID()},${ruleId},${version},
          ${transaction.json(jsonValue(normalizeCrawlPlan(definition)))},${generatedBy},${timestamp}
        ) RETURNING *
      `;
      await transaction`
        UPDATE rules SET active_version_id=${String(rows[0]!.id)},updated_at=${timestamp}
        WHERE id=${ruleId}
      `;
      await appendEvent(transaction, 'collection.rule.version-created', 'rule', ruleId, {
        taskId,
        version,
      });
      return ruleVersionRow(rows[0] as PgRow);
    });
  }

  async getActiveRule(taskId: string): Promise<ActiveRuleRecord | null> {
    const rows = await this.sql`
      SELECT r.id AS rule_id,r.task_id,r.name,r.active_version_id,
        r.created_at AS rule_created_at,r.updated_at,
        v.id AS version_id,v.version,v.definition,v.generated_by,
        v.created_at AS version_created_at
      FROM rules r JOIN rule_versions v ON v.id=r.active_version_id
      WHERE r.task_id=${taskId} LIMIT 1
    `;
    const row = rows[0] as PgRow | undefined;
    return row ? activeRuleRow(row) : null;
  }

  async createRun(taskId: string): Promise<CrawlRun> {
    return this.sql.begin(async (transaction) => {
      const id = randomUUID();
      const timestamp = new Date();
      const rows = await transaction`
        INSERT INTO runs(
          id,task_id,status,request_count,record_count,browser_used,ai_used,phase,progress,
          dataset_stats,delivery_status,warning_count,metadata,created_at
        ) VALUES (
          ${id},${taskId},'queued',0,0,false,false,'queued',0,
          ${transaction.json(jsonValue(emptyStats()))},'idle',0,
          ${transaction.json(jsonValue({}))},${timestamp}
        ) RETURNING *
      `;
      await appendEvent(transaction, 'collection.run.queued', 'run', id, { taskId });
      return runRow(rows[0] as PgRow);
    });
  }

  async listRuns(taskId: string): Promise<CrawlRun[]> {
    const rows = await this.sql`
      SELECT * FROM runs WHERE task_id=${taskId} ORDER BY created_at DESC,id DESC
    `;
    return rows.map((row) => runRow(row as PgRow));
  }

  async getRun(id: string): Promise<CrawlRun | null> {
    const rows = await this.sql`SELECT * FROM runs WHERE id=${id}`;
    return rows[0] ? runRow(rows[0] as PgRow) : null;
  }

  async startRun(runId: string, taskId: string): Promise<boolean> {
    return this.sql.begin(async (transaction) => {
      const timestamp = new Date();
      const rows = await transaction`
        UPDATE runs SET
          status='running',started_at=${timestamp},phase='starting',progress=0.02,error=NULL,
          error_code=NULL
        WHERE id=${runId} AND task_id=${taskId} AND status='queued' RETURNING id
      `;
      if (rows.length === 0) return false;
      await transaction`
        UPDATE tasks SET status='running',updated_at=${timestamp} WHERE id=${taskId}
      `;
      await appendEvent(transaction, 'collection.run.started', 'run', runId, { taskId });
      return true;
    });
  }

  async markRunPersisting(runId: string, taskId: string): Promise<boolean> {
    const rows = await this.sql`
      UPDATE runs SET phase='persisting',progress=GREATEST(progress,0.9)
      WHERE id=${runId} AND task_id=${taskId} AND status='running'
        AND cancel_requested_at IS NULL RETURNING id
    `;
    return rows.length === 1;
  }

  async completeRun(
    runId: string,
    taskId: string,
    input: RunCompletionInput,
  ): Promise<CrawlRun | null> {
    return this.sql.begin(async (transaction) => {
      const selected = await transaction`SELECT * FROM runs WHERE id=${runId} FOR UPDATE`;
      const existing = selected[0] as PgRow | undefined;
      if (existing?.status === 'succeeded') return runRow(existing);
      const timestamp = new Date();
      const rows = await transaction`
        UPDATE runs SET
          status='succeeded',finished_at=${timestamp},request_count=${input.requestCount},
          record_count=${input.recordCount},browser_used=${input.browserUsed},ai_used=${input.aiUsed},
          phase='completed',progress=1,
          dataset_stats=${transaction.json(jsonValue(input.datasetStats))},
          dataset_id=${input.datasetId},dataset_snapshot_id=${input.datasetSnapshotId},
          metadata=${transaction.json(
            jsonValue({
              ...input.metadata,
              datasetId: input.datasetId,
              datasetSnapshotId: input.datasetSnapshotId,
            }),
          )}
        WHERE id=${runId} AND task_id=${taskId} AND status='running' AND phase='persisting'
          AND cancel_requested_at IS NULL RETURNING *
      `;
      if (!rows[0]) return null;
      await transaction`
        UPDATE tasks SET status='succeeded',updated_at=${timestamp} WHERE id=${taskId}
      `;
      await appendEvent(transaction, 'collection.run.succeeded', 'run', runId, {
        taskId,
        datasetId: input.datasetId,
        datasetSnapshotId: input.datasetSnapshotId,
      });
      return runRow(rows[0] as PgRow);
    });
  }

  async failRun(
    runId: string,
    taskId: string,
    error: string,
    code: string,
  ): Promise<CrawlRun | null> {
    return this.sql.begin(async (transaction) => {
      const timestamp = new Date();
      const rows = await transaction`
        UPDATE runs SET
          status='failed',finished_at=${timestamp},error=${error},error_code=${code},
          phase='failed',progress=1
        WHERE id=${runId} AND task_id=${taskId} AND status IN ('queued','running') RETURNING *
      `;
      if (!rows[0]) return null;
      await transaction`
        UPDATE tasks SET status='failed',updated_at=${timestamp} WHERE id=${taskId}
      `;
      await appendEvent(transaction, 'collection.run.failed', 'run', runId, { taskId, code });
      return runRow(rows[0] as PgRow);
    });
  }

  async requestRunCancellation(runId: string): Promise<CrawlRun | null> {
    return this.sql.begin(async (transaction) => {
      const selected = await transaction`SELECT * FROM runs WHERE id=${runId} FOR UPDATE`;
      const row = selected[0] as PgRow | undefined;
      if (!row || !['queued', 'running'].includes(String(row.status))) return null;
      if (row.status === 'queued') return cancelRunInTransaction(transaction, row);
      const timestamp = new Date();
      const rows = await transaction`
        UPDATE runs SET cancel_requested_at=${timestamp},phase='canceling'
        WHERE id=${runId} RETURNING *
      `;
      await appendEvent(transaction, 'collection.run.cancel-requested', 'run', runId, {
        taskId: row.task_id,
      });
      return runRow(rows[0] as PgRow);
    });
  }

  async cancelRun(runId: string): Promise<CrawlRun | null> {
    return this.sql.begin(async (transaction) => {
      const selected = await transaction`SELECT * FROM runs WHERE id=${runId} FOR UPDATE`;
      const row = selected[0] as PgRow | undefined;
      return row && ['queued', 'running'].includes(String(row.status))
        ? cancelRunInTransaction(transaction, row)
        : null;
    });
  }

  async appendRunLog(
    entry: Omit<RunLogEntry, 'id' | 'sequence' | 'createdAt'>,
  ): Promise<RunLogEntry> {
    return this.sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${entry.runId},2))`;
      const current = await transaction`
        SELECT COALESCE(MAX(sequence),0) AS sequence FROM run_logs WHERE run_id=${entry.runId}
      `;
      const id = randomUUID();
      const timestamp = new Date();
      const rows = await transaction`
        INSERT INTO run_logs(
          id,run_id,sequence,level,phase,message,url,error_code,metadata,created_at
        ) VALUES (
          ${id},${entry.runId},${Number(current[0]?.sequence ?? 0) + 1},${entry.level},
          ${entry.phase},${entry.message},${entry.url},${entry.errorCode},
          ${transaction.json(jsonValue(entry.metadata))},${timestamp}
        ) RETURNING *
      `;
      const progress = entry.metadata.progress;
      await transaction`
        UPDATE runs SET
          phase=${entry.phase},
          progress=CASE
            WHEN ${typeof progress === 'number'} THEN ${typeof progress === 'number' ? progress : 0}
            ELSE progress
          END,
          warning_count=warning_count+${entry.level === 'warn' ? 1 : 0}
        WHERE id=${entry.runId}
      `;
      return runLogRow(rows[0] as PgRow);
    });
  }

  async listRunLogs(runId: string, afterSequence = 0, limit = 200): Promise<RunLogEntry[]> {
    const rows = await this.sql`
      SELECT * FROM run_logs WHERE run_id=${runId} AND sequence>${afterSequence}
      ORDER BY sequence LIMIT ${Math.min(Math.max(limit, 1), 1_000)}
    `;
    return rows.map((row) => runLogRow(row as PgRow));
  }

  async appendRunRequest(
    entry: Omit<RunRequestEntry, 'id' | 'createdAt'>,
  ): Promise<RunRequestEntry> {
    const rows = await this.sql`
      INSERT INTO run_requests(
        id,run_id,url,kind,status,status_code,duration_ms,error_code,error,created_at
      ) VALUES (
        ${randomUUID()},${entry.runId},${entry.url},${entry.kind},${entry.status},
        ${entry.statusCode},${entry.durationMs},${entry.errorCode},${entry.error},${new Date()}
      ) RETURNING *
    `;
    return runRequestRow(rows[0] as PgRow);
  }

  async listRunRequests(runId: string, cursor?: string, limit = 100) {
    const pageSize = Math.min(Math.max(limit, 1), 500);
    const decoded = cursor ? decodeCursor(cursor) : null;
    const rows = decoded
      ? await this.sql`
          SELECT * FROM run_requests WHERE run_id=${runId}
            AND (created_at>${new Date(decoded.at)}
              OR (created_at=${new Date(decoded.at)} AND id>${decoded.id}))
          ORDER BY created_at,id LIMIT ${pageSize + 1}
        `
      : await this.sql`
          SELECT * FROM run_requests WHERE run_id=${runId}
          ORDER BY created_at,id LIMIT ${pageSize + 1}
        `;
    const items = rows.slice(0, pageSize).map((row) => runRequestRow(row as PgRow));
    return {
      items,
      nextCursor:
        rows.length > pageSize ? encodeCursor(items.at(-1)!.createdAt, items.at(-1)!.id) : null,
    };
  }

  async listScheduledTasks() {
    const rows = await this.sql`SELECT * FROM task_schedules ORDER BY task_id`;
    return rows.map((row) => ({
      id: String(row.task_id),
      schedule: {
        mode: 'cron' as const,
        cron: String(row.cron),
        timezone: String(row.timezone),
        misfirePolicy: row.misfire_policy as 'skip' | 'run-once',
      },
      lastTriggeredAt: iso(row.last_triggered_at),
      updatedAt: iso(row.updated_at)!,
    }));
  }

  async markScheduleTriggered(
    taskId: string,
    triggeredAt = new Date().toISOString(),
  ): Promise<void> {
    await this.sql`
      UPDATE task_schedules SET last_triggered_at=${new Date(triggeredAt)},updated_at=${new Date()}
      WHERE task_id=${taskId}
    `;
  }

  async createRuleRepairProposal(
    input: Parameters<CollectionRepository['createRuleRepairProposal']>[0],
  ): Promise<RuleRepairProposal> {
    const rows = await this.sql`
      INSERT INTO rule_repair_proposals(
        id,task_id,rule_id,run_id,definition,explanation,status,created_at
      ) VALUES (
        ${randomUUID()},${input.taskId},${input.ruleId},${input.runId},
        ${this.sql.json(jsonValue(normalizeCrawlPlan(input.definition)))},
        ${input.explanation},'pending',${new Date()}
      ) RETURNING *
    `;
    return repairProposalRow(rows[0] as PgRow);
  }

  async listRuleRepairProposals(ruleId: string): Promise<RuleRepairProposal[]> {
    const rows = await this.sql`
      SELECT * FROM rule_repair_proposals WHERE rule_id=${ruleId}
      ORDER BY created_at DESC,id DESC
    `;
    return rows.map((row) => repairProposalRow(row as PgRow));
  }

  async updateRuleRepairProposal(
    id: string,
    status: RuleRepairProposal['status'],
  ): Promise<RuleRepairProposal | null> {
    const rows = await this.sql`
      UPDATE rule_repair_proposals SET status=${status} WHERE id=${id} RETURNING *
    `;
    return rows[0] ? repairProposalRow(rows[0] as PgRow) : null;
  }

  async markRuleRepairProposalTested(id: string): Promise<RuleRepairProposal | null> {
    const rows = await this.sql`
      UPDATE rule_repair_proposals SET tested_at=${new Date()} WHERE id=${id} RETURNING *
    `;
    return rows[0] ? repairProposalRow(rows[0] as PgRow) : null;
  }
}

function taskRow(row: PgRow): CollectionTask {
  return {
    id: String(row.id),
    name: String(row.name),
    startUrl: String(row.start_url),
    instruction: String(row.instruction),
    status: row.status as CollectionTask['status'],
    schedule: objectValue(row.schedule) as CollectionTask['schedule'],
    requestSettings: objectValue(row.request_settings) as CollectionTask['requestSettings'],
    browserSettings: objectValue(row.browser_settings) as CollectionTask['browserSettings'],
    pagination: objectValue(row.pagination) as CollectionTask['pagination'],
    outputSettings: objectValue(row.output_settings) as CollectionTask['outputSettings'],
    credentialBindings: objectValue(
      row.credential_bindings,
    ) as CollectionTask['credentialBindings'],
    datasetSettings: objectValue(row.dataset_settings) as CollectionTask['datasetSettings'],
    retentionPolicy: objectValue(row.retention_policy) as CollectionTask['retentionPolicy'],
    networkPolicy: objectValue(row.network_policy) as CollectionTask['networkPolicy'],
    revision: Number(row.revision),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function ruleRow(row: PgRow): RuleRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    name: String(row.name),
    activeVersionId: nullableString(row.active_version_id),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function ruleVersionRow(row: PgRow): RuleVersionRecord {
  return {
    id: String(row.id),
    ruleId: String(row.rule_id),
    version: Number(row.version),
    definition: normalizeCrawlPlan(objectValue(row.definition)),
    generatedBy: row.generated_by as RuleVersionRecord['generatedBy'],
    createdAt: iso(row.created_at)!,
  };
}

function activeRuleRow(row: PgRow): ActiveRuleRecord {
  return {
    rule: {
      id: String(row.rule_id),
      taskId: String(row.task_id),
      name: String(row.name),
      activeVersionId: nullableString(row.active_version_id),
      createdAt: iso(row.rule_created_at)!,
      updatedAt: iso(row.updated_at)!,
    },
    version: {
      id: String(row.version_id),
      ruleId: String(row.rule_id),
      version: Number(row.version),
      definition: normalizeCrawlPlan(objectValue(row.definition)),
      generatedBy: row.generated_by as RuleVersionRecord['generatedBy'],
      createdAt: iso(row.version_created_at)!,
    },
  };
}

function runRow(row: PgRow): CrawlRun {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    status: row.status as CrawlRun['status'],
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    requestCount: Number(row.request_count),
    recordCount: Number(row.record_count),
    browserUsed: Boolean(row.browser_used),
    aiUsed: Boolean(row.ai_used),
    error: nullableString(row.error),
    errorCode: nullableString(row.error_code),
    phase: String(row.phase),
    progress: Number(row.progress),
    cancelRequestedAt: iso(row.cancel_requested_at),
    datasetStats: objectValue(row.dataset_stats) as CrawlRun['datasetStats'],
    deliveryStatus: row.delivery_status as CrawlRun['deliveryStatus'],
    warningCount: Number(row.warning_count),
    metadata: objectValue(row.metadata),
    createdAt: iso(row.created_at)!,
  };
}

function runLogRow(row: PgRow): RunLogEntry {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    sequence: Number(row.sequence),
    level: row.level as RunLogEntry['level'],
    phase: String(row.phase),
    message: String(row.message),
    url: nullableString(row.url),
    errorCode: nullableString(row.error_code),
    metadata: objectValue(row.metadata),
    createdAt: iso(row.created_at)!,
  };
}

function runRequestRow(row: PgRow): RunRequestEntry {
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
    createdAt: iso(row.created_at)!,
  };
}

function repairProposalRow(row: PgRow): RuleRepairProposal {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    ruleId: String(row.rule_id),
    runId: nullableString(row.run_id),
    definition: normalizeCrawlPlan(objectValue(row.definition)),
    explanation: String(row.explanation),
    status: row.status as RuleRepairProposal['status'],
    testedAt: iso(row.tested_at),
    createdAt: iso(row.created_at)!,
  };
}

async function cancelRunInTransaction(transaction: PgTransaction, row: PgRow): Promise<CrawlRun> {
  const timestamp = new Date();
  const rows = await transaction`
    UPDATE runs SET
      status='canceled',finished_at=${timestamp},error='Canceled by user',error_code='CANCELED',
      phase='canceled',progress=1 WHERE id=${String(row.id)} RETURNING *
  `;
  await transaction`
    UPDATE tasks SET status='ready',updated_at=${timestamp} WHERE id=${String(row.task_id)}
  `;
  await appendEvent(transaction, 'collection.run.canceled', 'run', String(row.id), {
    taskId: row.task_id,
  });
  return runRow(rows[0] as PgRow);
}

async function syncSchedule(
  transaction: PgTransaction,
  taskId: string,
  schedule: CollectionTask['schedule'],
  timestamp: Date,
): Promise<void> {
  if (schedule.mode !== 'cron' || !schedule.cron) {
    await transaction`DELETE FROM task_schedules WHERE task_id=${taskId}`;
    return;
  }
  await transaction`
    INSERT INTO task_schedules(
      task_id,cron,timezone,misfire_policy,last_triggered_at,updated_at
    ) VALUES (
      ${taskId},${schedule.cron},${schedule.timezone},${schedule.misfirePolicy},NULL,${timestamp}
    ) ON CONFLICT(task_id) DO UPDATE SET
      cron=EXCLUDED.cron,timezone=EXCLUDED.timezone,
      misfire_policy=EXCLUDED.misfire_policy,updated_at=EXCLUDED.updated_at
  `;
}

async function appendEvent(
  transaction: PgTransaction,
  type: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await transaction`
    INSERT INTO platform_events(
      id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
    ) VALUES (
      ${randomUUID()},${type},1,'collection',${aggregateType},${aggregateId},
      ${transaction.json(jsonValue(payload))},${new Date()}
    )
  `;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  return (value ?? {}) as Record<string, unknown>;
}

function jsonValue(value: unknown): postgres.JSONValue {
  return value as postgres.JSONValue;
}

function emptyStats() {
  return { added: 0, updated: 0, removed: 0, unchanged: 0, current: 0 };
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify({ at, id })).toString('base64url');
}

function decodeCursor(cursor: string): { at: string; id: string } {
  const value = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as PgRow;
  if (typeof value.at !== 'string' || typeof value.id !== 'string') {
    throw new Error('Invalid Collection cursor');
  }
  return { at: value.at, id: value.id };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
