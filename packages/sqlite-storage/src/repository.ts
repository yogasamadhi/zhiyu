import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type {
  ActiveRuleRecord,
  ArtifactDescriptor,
  ApiToken,
  BrowserSettings,
  DatasetRecord,
  DatasetRecordPage,
  DatasetSettings,
  DatasetStats,
  DeliveryAttempt,
  CrawlRun,
  CrawlTask,
  DatasetDiffPage,
  DomainEvent,
  DomainEventPage,
  ExtractedRecord,
  GeneratedBy,
  OutputDestination,
  PreferenceSignal,
  PreferenceSignalInput,
  PreferenceSignalPage,
  RecordChange,
  RecordChangePage,
  RecordPage,
  Repository,
  RetentionPolicy,
  RuleRecord,
  RuleVersionRecord,
  RuleDefinitionInput,
  RuleRepairProposal,
  RunLogEntry,
  RunLogPage,
  RunRequestEntry,
  RunRequestPage,
  RunSuccessOutcome,
  RuntimeJob,
  TaskCreate,
  TaskDetail,
  TaskListItem,
  TaskUpdate,
  TrendSourceBinding,
} from '@zhiyun/contracts';
import { normalizeCrawlPlan, preferenceContentSchema, scheduleSchema } from '@zhiyun/contracts';
import { migrateDesktopDatabase } from './migrations.js';
import * as schema from './schema.js';

type SqlRow = Record<string, unknown>;

function parseJson<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function now(): string {
  return new Date().toISOString();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function contentHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function recordKey(data: Record<string, unknown>, settings: DatasetSettings): string {
  if (settings.keyFields.length > 0) {
    return createHash('sha256')
      .update(canonical(settings.keyFields.map((field) => data[field] ?? null)))
      .digest('hex');
  }
  return contentHash(data);
}

function taskRow(row: SqlRow): CrawlTask {
  return {
    id: String(row.id),
    name: String(row.name),
    startUrl: String(row.start_url),
    instruction: String(row.instruction),
    status: row.status as CrawlTask['status'],
    schedule: scheduleSchema.parse(parseJson(row.schedule)),
    requestSettings: parseJson(row.request_settings),
    browserSettings: parseJson(row.browser_settings),
    pagination: parseJson(row.pagination),
    outputSettings: parseJson(row.output_settings),
    credentialBindings: parseJson(row.credential_bindings),
    datasetSettings: parseJson(row.dataset_settings),
    retentionPolicy: parseJson(row.retention_policy),
    networkPolicy: parseJson(row.network_policy),
    outputBindings: parseJson(row.output_bindings),
    revision: Number(row.revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function trendSourceRow(row: SqlRow): TrendSourceBinding {
  return {
    key: String(row.key),
    platform: row.platform as TrendSourceBinding['platform'],
    taskId: row.task_id ? String(row.task_id) : null,
    enabled: Boolean(row.enabled),
    autoRefresh: Boolean(row.auto_refresh),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function preferenceSignalRow(row: SqlRow): PreferenceSignal {
  return {
    id: String(row.id),
    targetKey: String(row.target_key),
    kind: row.kind as PreferenceSignal['kind'],
    content: preferenceContentSchema.parse(parseJson(row.content)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function runRow(row: SqlRow): CrawlRun {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    status: row.status as CrawlRun['status'],
    startedAt: row.started_at ? String(row.started_at) : null,
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    requestCount: Number(row.request_count),
    recordCount: Number(row.record_count),
    browserUsed: Boolean(row.browser_used),
    aiUsed: Boolean(row.ai_used),
    error: row.error ? String(row.error) : null,
    errorCode: row.error_code ? String(row.error_code) : null,
    phase: String(row.phase),
    progress: Number(row.progress),
    cancelRequestedAt: row.cancel_requested_at ? String(row.cancel_requested_at) : null,
    datasetStats: parseJson(row.dataset_stats),
    deliveryStatus: row.delivery_status as CrawlRun['deliveryStatus'],
    warningCount: Number(row.warning_count),
    metadata: parseJson(row.metadata),
    createdAt: String(row.created_at),
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

function versionRow(row: SqlRow): RuleVersionRecord {
  return {
    id: String(row.id),
    ruleId: String(row.rule_id),
    version: Number(row.version),
    definition: normalizeCrawlPlan(parseJson(row.definition)),
    generatedBy: row.generated_by as GeneratedBy,
    createdAt: String(row.created_at),
  };
}

function recordRow(row: SqlRow): ExtractedRecord {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    runId: String(row.run_id),
    sourceUrl: String(row.source_url),
    data: parseJson(row.data),
    createdAt: String(row.created_at),
  };
}

function datasetRecordRow(row: SqlRow): DatasetRecord {
  return {
    id: String(row.id),
    datasetId: String(row.dataset_id),
    taskId: String(row.task_id),
    recordKey: String(row.record_key),
    sourceUrl: String(row.source_url),
    data: parseJson(row.data),
    contentHash: String(row.content_hash),
    removed: Boolean(row.removed),
    firstRunId: row.first_run_id ? String(row.first_run_id) : null,
    lastRunId: row.last_run_id ? String(row.last_run_id) : null,
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
  };
}

function recordChangeRow(row: SqlRow): RecordChange {
  return {
    id: String(row.id),
    datasetId: String(row.dataset_id),
    datasetRecordId: String(row.dataset_record_id),
    runId: String(row.run_id),
    type: row.type as RecordChange['type'],
    before: row.before ? parseJson(row.before) : null,
    after: row.after ? parseJson(row.after) : null,
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
    url: row.url ? String(row.url) : null,
    errorCode: row.error_code ? String(row.error_code) : null,
    metadata: parseJson(row.metadata),
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
    errorCode: row.error_code ? String(row.error_code) : null,
    error: row.error ? String(row.error) : null,
    createdAt: String(row.created_at),
  };
}

function outputDestinationRow(row: SqlRow): OutputDestination {
  return {
    id: String(row.id),
    name: String(row.name),
    type: row.type as OutputDestination['type'],
    config: parseJson(row.config),
    credentialRef: row.credential_ref ? String(row.credential_ref) : null,
    enabled: Boolean(row.enabled),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function deliveryAttemptRow(row: SqlRow): DeliveryAttempt {
  return {
    id: String(row.id),
    destinationId: String(row.destination_id),
    taskId: String(row.task_id),
    runId: String(row.run_id),
    status: row.status as DeliveryAttempt['status'],
    attempt: Number(row.attempt),
    responseStatus: row.response_status === null ? null : Number(row.response_status),
    error: row.error ? String(row.error) : null,
    nextAttemptAt: row.next_attempt_at ? String(row.next_attempt_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function repairProposalRow(row: SqlRow): RuleRepairProposal {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    ruleId: String(row.rule_id),
    runId: row.run_id ? String(row.run_id) : null,
    definition: normalizeCrawlPlan(parseJson(row.definition)),
    explanation: String(row.explanation),
    status: row.status as RuleRepairProposal['status'],
    testedAt: row.tested_at ? String(row.tested_at) : null,
    createdAt: String(row.created_at),
  };
}

function apiTokenRow(row: SqlRow): ApiToken {
  return {
    id: String(row.id),
    name: String(row.name),
    taskIds: parseJson(row.task_ids),
    rateLimitPerMinute: Number(row.rate_limit_per_minute),
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    createdAt: String(row.created_at),
  };
}

function eventRow(row: SqlRow): DomainEvent {
  return {
    cursor: Number(row.cursor),
    id: String(row.id),
    type: String(row.type),
    aggregateType: row.aggregate_type as DomainEvent['aggregateType'],
    aggregateId: String(row.aggregate_id),
    payload: parseJson(row.payload),
    createdAt: String(row.created_at),
  };
}

export class SqliteRepository implements Repository {
  readonly orm: BetterSQLite3Database<typeof schema>;
  private readonly sqlite: Database.Database;
  private writer: Promise<void> = Promise.resolve();

  constructor(readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    const pendingRestore = `${filePath}.restore`;
    if (filePath !== ':memory:' && existsSync(pendingRestore)) {
      if (existsSync(filePath))
        renameSync(filePath, `${filePath}.before-restore-${Date.now()}.bak`);
      renameSync(pendingRestore, filePath);
    }
    this.sqlite = new Database(filePath);
    this.orm = drizzle(this.sqlite, { schema });
  }

  private write<T>(action: () => T): Promise<T> {
    const result = this.writer.then(action, action);
    this.writer = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private appendEventSync(event: Omit<DomainEvent, 'id' | 'cursor' | 'createdAt'>): DomainEvent {
    const id = crypto.randomUUID();
    const createdAt = now();
    const result = this.sqlite
      .prepare(
        'INSERT INTO domain_events(id, type, aggregate_type, aggregate_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        event.type,
        event.aggregateType,
        event.aggregateId,
        JSON.stringify(event.payload),
        createdAt,
      );
    return { ...event, id, cursor: Number(result.lastInsertRowid), createdAt };
  }

  private completeRunSync(
    runId: string,
    taskId: string,
    outcome: RunSuccessOutcome,
    settings: DatasetSettings = { mode: 'snapshot', keyFields: [], detectRemoved: true },
  ): void {
    const insert = this.sqlite.prepare(
      'INSERT INTO records(id,task_id,run_id,record_key,content_hash,source_url,data,created_at) VALUES (?,?,?,?,?,?,?,?)',
    );
    const createdAt = now();
    for (const [index, record] of outcome.records.entries()) {
      const baseKey = recordKey(record.data, settings);
      insert.run(
        crypto.randomUUID(),
        taskId,
        runId,
        settings.mode === 'append' ? `${runId}:${baseKey}:${index}` : baseKey,
        contentHash(record.data),
        record.sourceUrl,
        JSON.stringify(record.data),
        createdAt,
      );
    }
    const changed = this.sqlite
      .prepare(
        `UPDATE runs SET status='succeeded',finished_at=?,request_count=?,record_count=?,
          browser_used=?,ai_used=?,metadata=?,phase='completed',progress=1,warning_count=?
          WHERE id=? AND task_id=? AND status IN ('queued','running')`,
      )
      .run(
        createdAt,
        outcome.requestCount,
        outcome.recordCount,
        Number(outcome.browserUsed),
        Number(outcome.aiUsed),
        JSON.stringify(outcome.metadata),
        Array.isArray(outcome.metadata.warnings) ? outcome.metadata.warnings.length : 0,
        runId,
        taskId,
      ).changes;
    if (!changed) throw new Error(`Run ${runId} is no longer completable`);
    this.sqlite
      .prepare("UPDATE tasks SET status='succeeded',updated_at=? WHERE id=?")
      .run(createdAt, taskId);
    this.appendEventSync({
      type: 'run.succeeded',
      aggregateType: 'run',
      aggregateId: runId,
      payload: { taskId, recordCount: outcome.recordCount },
    });
  }

  async health(): Promise<void> {
    const value = this.sqlite.pragma('quick_check', { simple: true });
    if (value !== 'ok') throw new Error(`SQLite quick check failed: ${String(value)}`);
  }

  async migrate(): Promise<void> {
    await this.write(() => migrateDesktopDatabase(this.sqlite, this.filePath));
  }

  async close(): Promise<void> {
    await this.writer;
    this.sqlite.close();
  }

  async diagnostics(): Promise<Record<string, unknown>> {
    const pageCount = Number(this.sqlite.pragma('page_count', { simple: true }));
    const pageSize = Number(this.sqlite.pragma('page_size', { simple: true }));
    return {
      engine: 'sqlite',
      filePath: this.filePath,
      size: pageCount * pageSize,
      journalMode: this.sqlite.pragma('journal_mode', { simple: true }),
      integrity: this.sqlite.pragma('quick_check', { simple: true }),
      sqliteVersion: this.sqlite.prepare('select sqlite_version() as version').get(),
    };
  }

  async createBackup(): Promise<Buffer> {
    const target = join(tmpdir(), `zhiyun-backup-${crypto.randomUUID()}.sqlite3`);
    await this.writer;
    try {
      await this.sqlite.backup(target);
      return await readFile(target);
    } finally {
      await unlink(target).catch(() => undefined);
    }
  }

  async stageRestore(data: Buffer): Promise<void> {
    if (this.filePath === ':memory:') throw new Error('In-memory databases cannot be restored');
    const temporary = join(tmpdir(), `zhiyun-restore-${crypto.randomUUID()}.sqlite3`);
    try {
      await writeFile(temporary, data, { mode: 0o600 });
      const validation = new Database(temporary, { readonly: true });
      try {
        if (validation.pragma('integrity_check', { simple: true }) !== 'ok') {
          throw new Error('Backup integrity check failed');
        }
      } finally {
        validation.close();
      }
      await rename(temporary, `${this.filePath}.restore`);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async recoverInterruptedRuns(): Promise<number> {
    return this.write(() =>
      this.sqlite.transaction(() => {
        const rows = this.sqlite
          .prepare("SELECT * FROM runs WHERE status = 'running'")
          .all() as SqlRow[];
        for (const row of rows) {
          this.sqlite
            .prepare(
              "UPDATE runs SET status = 'failed', finished_at = ?, error = ?, metadata = ? WHERE id = ?",
            )
            .run(
              now(),
              'Runtime was interrupted before the run completed',
              JSON.stringify({ errorCode: 'RUNTIME_INTERRUPTED' }),
              row.id,
            );
          this.sqlite
            .prepare("DELETE FROM runtime_jobs WHERE run_id = ? AND state = 'running'")
            .run(row.id);
          this.sqlite
            .prepare("UPDATE tasks SET status = 'failed', updated_at = ? WHERE id = ?")
            .run(now(), row.task_id);
          this.appendEventSync({
            type: 'run.failed',
            aggregateType: 'run',
            aggregateId: String(row.id),
            payload: { taskId: row.task_id, code: 'RUNTIME_INTERRUPTED' },
          });
        }
        return rows.length;
      })(),
    );
  }

  async createTask(input: TaskCreate): Promise<CrawlTask> {
    return this.write(() =>
      this.sqlite.transaction(() => {
        const id = crypto.randomUUID();
        const createdAt = now();
        this.sqlite
          .prepare(
            `INSERT INTO tasks(
              id,name,start_url,instruction,status,schedule,request_settings,browser_settings,
              pagination,output_settings,credential_bindings,dataset_settings,retention_policy,
              network_policy,output_bindings,revision,created_at,updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            id,
            input.name,
            input.startUrl,
            input.instruction,
            'draft',
            JSON.stringify(input.schedule),
            JSON.stringify(input.requestSettings),
            JSON.stringify(input.browserSettings),
            JSON.stringify(input.pagination),
            JSON.stringify(input.outputSettings),
            JSON.stringify(input.credentialBindings),
            JSON.stringify(input.datasetSettings),
            JSON.stringify(input.retentionPolicy),
            JSON.stringify(input.networkPolicy),
            JSON.stringify(input.outputBindings),
            1,
            createdAt,
            createdAt,
          );
        if (input.schedule.mode === 'cron' && input.schedule.cron) {
          this.sqlite
            .prepare(
              'INSERT INTO task_schedules(task_id,cron,timezone,misfire_policy,last_triggered_at,updated_at) VALUES (?,?,?,?,NULL,?)',
            )
            .run(
              id,
              input.schedule.cron,
              input.schedule.timezone,
              input.schedule.misfirePolicy,
              createdAt,
            );
        }
        const insertBinding = this.sqlite.prepare(
          'INSERT INTO task_output_bindings(task_id,destination_id,created_at) VALUES (?,?,?)',
        );
        for (const destinationId of input.outputBindings) {
          insertBinding.run(id, destinationId, createdAt);
        }
        this.appendEventSync({
          type: 'task.created',
          aggregateType: 'task',
          aggregateId: id,
          payload: { revision: 1 },
        });
        return taskRow(this.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as SqlRow);
      })(),
    );
  }

  async listTasks(): Promise<TaskListItem[]> {
    const rows = this.sqlite
      .prepare('SELECT * FROM tasks ORDER BY updated_at DESC')
      .all() as SqlRow[];
    return rows.map((row) => {
      const latest = this.sqlite
        .prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(row.id) as SqlRow | undefined;
      return { ...taskRow(row), latestRun: latest ? runRow(latest) : null };
    });
  }

  async getTask(id: string): Promise<TaskDetail | null> {
    const row = this.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      SqlRow | undefined;
    return row ? { ...taskRow(row), activeRule: await this.getActiveRule(id) } : null;
  }

  async updateTask(
    id: string,
    input: TaskUpdate,
    expectedRevision: number,
  ): Promise<CrawlTask | null> {
    return this.write(() =>
      this.sqlite.transaction(() => {
        const current = this.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
          SqlRow | undefined;
        if (!current || Number(current.revision) !== expectedRevision) return null;
        const base = taskRow(current);
        const merged = {
          ...base,
          name: input.name ?? base.name,
          startUrl: input.startUrl ?? base.startUrl,
          instruction: input.instruction ?? base.instruction,
          schedule: input.schedule ?? base.schedule,
          requestSettings: input.requestSettings ?? base.requestSettings,
          browserSettings: input.browserSettings ?? base.browserSettings,
          pagination: input.pagination ?? base.pagination,
          outputSettings: input.outputSettings ?? base.outputSettings,
          credentialBindings: input.credentialBindings ?? base.credentialBindings,
          datasetSettings: input.datasetSettings ?? base.datasetSettings,
          retentionPolicy: input.retentionPolicy ?? base.retentionPolicy,
          networkPolicy: input.networkPolicy ?? base.networkPolicy,
          outputBindings: input.outputBindings ?? base.outputBindings,
        };
        const updatedAt = now();
        this.sqlite
          .prepare(
            `UPDATE tasks SET name=?,start_url=?,instruction=?,schedule=?,request_settings=?,
              browser_settings=?,pagination=?,output_settings=?,credential_bindings=?,dataset_settings=?,
              retention_policy=?,network_policy=?,output_bindings=?,revision=?,updated_at=?
             WHERE id=? AND revision=?`,
          )
          .run(
            merged.name,
            merged.startUrl,
            merged.instruction,
            JSON.stringify(merged.schedule),
            JSON.stringify(merged.requestSettings),
            JSON.stringify(merged.browserSettings),
            JSON.stringify(merged.pagination),
            JSON.stringify(merged.outputSettings),
            JSON.stringify(merged.credentialBindings),
            JSON.stringify(merged.datasetSettings),
            JSON.stringify(merged.retentionPolicy),
            JSON.stringify(merged.networkPolicy),
            JSON.stringify(merged.outputBindings),
            expectedRevision + 1,
            updatedAt,
            id,
            expectedRevision,
          );
        if (input.schedule) {
          this.sqlite.prepare('DELETE FROM task_schedules WHERE task_id = ?').run(id);
          if (merged.schedule.mode === 'cron' && merged.schedule.cron) {
            this.sqlite
              .prepare(
                'INSERT INTO task_schedules(task_id,cron,timezone,misfire_policy,last_triggered_at,updated_at) VALUES (?,?,?,?,NULL,?)',
              )
              .run(
                id,
                merged.schedule.cron,
                merged.schedule.timezone,
                merged.schedule.misfirePolicy,
                updatedAt,
              );
          }
        }
        if (input.outputBindings) {
          this.sqlite.prepare('DELETE FROM task_output_bindings WHERE task_id=?').run(id);
          const insertBinding = this.sqlite.prepare(
            'INSERT INTO task_output_bindings(task_id,destination_id,created_at) VALUES (?,?,?)',
          );
          for (const destinationId of input.outputBindings) {
            insertBinding.run(id, destinationId, updatedAt);
          }
        }
        this.appendEventSync({
          type: 'task.updated',
          aggregateType: 'task',
          aggregateId: id,
          payload: { revision: expectedRevision + 1 },
        });
        return taskRow(this.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as SqlRow);
      })(),
    );
  }

  async deleteTask(id: string): Promise<boolean> {
    return this.write(() =>
      this.sqlite.transaction(() => {
        const deleted = this.sqlite.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0;
        if (deleted) {
          this.appendEventSync({
            type: 'task.deleted',
            aggregateType: 'task',
            aggregateId: id,
            payload: {},
          });
        }
        return deleted;
      })(),
    );
  }

  async listTrendSourceBindings(): Promise<TrendSourceBinding[]> {
    return (this.sqlite.prepare('SELECT * FROM trend_sources ORDER BY key').all() as SqlRow[]).map(
      trendSourceRow,
    );
  }

  async getTrendSourceBinding(key: string): Promise<TrendSourceBinding | null> {
    const row = this.sqlite.prepare('SELECT * FROM trend_sources WHERE key = ?').get(key) as
      SqlRow | undefined;
    return row ? trendSourceRow(row) : null;
  }

  async upsertTrendSourceBinding(
    input: Pick<TrendSourceBinding, 'key' | 'platform' | 'taskId' | 'enabled' | 'autoRefresh'>,
  ): Promise<TrendSourceBinding> {
    return this.write(() => {
      const timestamp = now();
      this.sqlite
        .prepare(
          `INSERT INTO trend_sources(key,platform,task_id,enabled,auto_refresh,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(key) DO UPDATE SET
             platform=excluded.platform,task_id=excluded.task_id,enabled=excluded.enabled,
             auto_refresh=excluded.auto_refresh,updated_at=excluded.updated_at`,
        )
        .run(
          input.key,
          input.platform,
          input.taskId,
          input.enabled ? 1 : 0,
          input.autoRefresh ? 1 : 0,
          timestamp,
          timestamp,
        );
      return trendSourceRow(
        this.sqlite.prepare('SELECT * FROM trend_sources WHERE key = ?').get(input.key) as SqlRow,
      );
    });
  }

  async updateTrendSourceBinding(
    key: string,
    input: Partial<Pick<TrendSourceBinding, 'taskId' | 'enabled' | 'autoRefresh'>>,
  ): Promise<TrendSourceBinding | null> {
    return this.write(() => {
      const current = this.sqlite.prepare('SELECT * FROM trend_sources WHERE key = ?').get(key) as
        SqlRow | undefined;
      if (!current) return null;
      this.sqlite
        .prepare(
          'UPDATE trend_sources SET task_id=?,enabled=?,auto_refresh=?,updated_at=? WHERE key=?',
        )
        .run(
          input.taskId === undefined ? current.task_id : input.taskId,
          input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0,
          input.autoRefresh === undefined ? current.auto_refresh : input.autoRefresh ? 1 : 0,
          now(),
          key,
        );
      return trendSourceRow(
        this.sqlite.prepare('SELECT * FROM trend_sources WHERE key = ?').get(key) as SqlRow,
      );
    });
  }

  async listPreferenceSignals(cursor?: string, limit = 100): Promise<PreferenceSignalPage> {
    const parsedOffset = cursor
      ? Number.parseInt(Buffer.from(cursor, 'base64url').toString(), 10)
      : 0;
    const offset = Number.isFinite(parsedOffset) ? parsedOffset : 0;
    const rows = this.sqlite
      .prepare('SELECT * FROM preference_signals ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?')
      .all(limit + 1, offset) as SqlRow[];
    return {
      items: rows.slice(0, limit).map(preferenceSignalRow),
      nextCursor:
        rows.length > limit ? Buffer.from(String(offset + limit)).toString('base64url') : null,
    };
  }

  async upsertPreferenceSignal(
    input: PreferenceSignalInput & { targetKey: string },
  ): Promise<PreferenceSignal> {
    return this.write(() =>
      this.sqlite.transaction(() => {
        if (input.kind === 'like' || input.kind === 'dislike') {
          this.sqlite
            .prepare('DELETE FROM preference_signals WHERE target_key=? AND kind=?')
            .run(input.targetKey, input.kind === 'like' ? 'dislike' : 'like');
        }
        const existing = this.sqlite
          .prepare('SELECT id,created_at FROM preference_signals WHERE target_key=? AND kind=?')
          .get(input.targetKey, input.kind) as SqlRow | undefined;
        const id = existing ? String(existing.id) : crypto.randomUUID();
        const timestamp = now();
        this.sqlite
          .prepare(
            `INSERT INTO preference_signals(
              id,target_key,kind,platform,content_type,external_id,title,content,created_at,updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(target_key,kind) DO UPDATE SET
              platform=excluded.platform,content_type=excluded.content_type,
              external_id=excluded.external_id,title=excluded.title,content=excluded.content,
              updated_at=excluded.updated_at`,
          )
          .run(
            id,
            input.targetKey,
            input.kind,
            input.content.platform,
            input.content.contentType,
            input.content.externalId,
            input.content.title,
            JSON.stringify(input.content),
            existing ? String(existing.created_at) : timestamp,
            timestamp,
          );
        return preferenceSignalRow(
          this.sqlite.prepare('SELECT * FROM preference_signals WHERE id = ?').get(id) as SqlRow,
        );
      })(),
    );
  }

  async deletePreferenceSignal(id: string): Promise<boolean> {
    return this.write(
      () => this.sqlite.prepare('DELETE FROM preference_signals WHERE id = ?').run(id).changes > 0,
    );
  }

  async clearPreferenceSignals(): Promise<number> {
    return this.write(() => this.sqlite.prepare('DELETE FROM preference_signals').run().changes);
  }

  async listScheduledTasks() {
    const rows = this.sqlite
      .prepare(
        'SELECT task_id,cron,timezone,misfire_policy,last_triggered_at,updated_at FROM task_schedules ORDER BY task_id',
      )
      .all() as SqlRow[];
    return rows.map((row) => ({
      id: String(row.task_id),
      schedule: scheduleSchema.parse({
        mode: 'cron',
        cron: String(row.cron),
        timezone: String(row.timezone),
        misfirePolicy: String(row.misfire_policy),
      }),
      lastTriggeredAt: row.last_triggered_at ? String(row.last_triggered_at) : null,
      updatedAt: String(row.updated_at),
    }));
  }

  async markScheduleTriggered(taskId: string, triggeredAt = now()): Promise<void> {
    await this.write(() => {
      this.sqlite
        .prepare('UPDATE task_schedules SET last_triggered_at=? WHERE task_id=?')
        .run(triggeredAt, taskId);
    });
  }

  async getSchedulingPaused(): Promise<boolean> {
    const row = this.sqlite
      .prepare("SELECT value FROM runtime_settings WHERE key='scheduler'")
      .get() as SqlRow | undefined;
    return row ? parseJson<{ paused?: boolean }>(row.value).paused === true : false;
  }

  async setSchedulingPaused(paused: boolean): Promise<void> {
    await this.write(() =>
      this.sqlite.transaction(() => {
        this.sqlite
          .prepare(
            `INSERT INTO runtime_settings(key,value,updated_at) VALUES ('scheduler',?,?)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
          )
          .run(JSON.stringify({ paused }), now());
        this.appendEventSync({
          type: paused ? 'scheduler.paused' : 'scheduler.resumed',
          aggregateType: 'runtime',
          aggregateId: 'scheduler',
          payload: { paused },
        });
      })(),
    );
  }

  async setTaskBrowserSettings(id: string, settings: BrowserSettings): Promise<void> {
    await this.write(() => {
      this.sqlite
        .prepare('UPDATE tasks SET browser_settings = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(settings), now(), id);
    });
  }

  async listRules(taskId: string): Promise<Array<RuleRecord & { versions: RuleVersionRecord[] }>> {
    const rules = this.sqlite
      .prepare('SELECT * FROM rules WHERE task_id = ? ORDER BY created_at DESC')
      .all(taskId) as SqlRow[];
    return rules.map((row) => ({
      ...ruleRow(row),
      versions: (
        this.sqlite
          .prepare('SELECT * FROM rule_versions WHERE rule_id = ? ORDER BY version DESC')
          .all(row.id) as SqlRow[]
      ).map(versionRow),
    }));
  }

  async createRule(
    taskId: string,
    name: string,
    definition: RuleDefinitionInput,
    generatedBy: GeneratedBy,
  ): Promise<{ rule: RuleRecord; version: RuleVersionRecord }> {
    return this.write(() =>
      this.sqlite.transaction(() => {
        const id = crypto.randomUUID();
        const versionId = crypto.randomUUID();
        const createdAt = now();
        this.sqlite
          .prepare(
            'INSERT INTO rules(id,task_id,name,active_version_id,created_at,updated_at) VALUES (?,?,?,?,?,?)',
          )
          .run(id, taskId, name, versionId, createdAt, createdAt);
        this.sqlite
          .prepare(
            'INSERT INTO rule_versions(id,rule_id,version,definition,generated_by,created_at) VALUES (?,?,?,?,?,?)',
          )
          .run(
            versionId,
            id,
            1,
            JSON.stringify(normalizeCrawlPlan(definition)),
            generatedBy,
            createdAt,
          );
        this.sqlite
          .prepare("UPDATE tasks SET status = 'ready', updated_at = ? WHERE id = ?")
          .run(createdAt, taskId);
        this.appendEventSync({
          type: 'rule.activated',
          aggregateType: 'rule',
          aggregateId: id,
          payload: { taskId, version: 1 },
        });
        return {
          rule: ruleRow(this.sqlite.prepare('SELECT * FROM rules WHERE id = ?').get(id) as SqlRow),
          version: versionRow(
            this.sqlite
              .prepare('SELECT * FROM rule_versions WHERE id = ?')
              .get(versionId) as SqlRow,
          ),
        };
      })(),
    );
  }

  async createRuleVersion(
    taskId: string,
    ruleId: string,
    definition: RuleDefinitionInput,
    generatedBy: GeneratedBy,
  ): Promise<RuleVersionRecord | null> {
    return this.write(() =>
      this.sqlite.transaction(() => {
        const rule = this.sqlite
          .prepare('SELECT * FROM rules WHERE id = ? AND task_id = ?')
          .get(ruleId, taskId) as SqlRow | undefined;
        if (!rule) return null;
        const current = this.sqlite
          .prepare(
            'SELECT COALESCE(MAX(version),0) AS version FROM rule_versions WHERE rule_id = ?',
          )
          .get(ruleId) as SqlRow;
        const next = Number(current.version) + 1;
        const id = crypto.randomUUID();
        const createdAt = now();
        this.sqlite
          .prepare(
            'INSERT INTO rule_versions(id,rule_id,version,definition,generated_by,created_at) VALUES (?,?,?,?,?,?)',
          )
          .run(
            id,
            ruleId,
            next,
            JSON.stringify(normalizeCrawlPlan(definition)),
            generatedBy,
            createdAt,
          );
        this.sqlite
          .prepare('UPDATE rules SET active_version_id = ?, updated_at = ? WHERE id = ?')
          .run(id, createdAt, ruleId);
        this.appendEventSync({
          type: 'rule.activated',
          aggregateType: 'rule',
          aggregateId: ruleId,
          payload: { taskId, version: next },
        });
        return versionRow(
          this.sqlite.prepare('SELECT * FROM rule_versions WHERE id = ?').get(id) as SqlRow,
        );
      })(),
    );
  }

  async getActiveRule(taskId: string): Promise<ActiveRuleRecord | null> {
    const row = this.sqlite
      .prepare(
        `SELECT r.id AS r_id,r.task_id,r.name,r.active_version_id,r.created_at AS r_created_at,
                r.updated_at,v.id AS v_id,v.rule_id,v.version,v.definition,v.generated_by,
                v.created_at AS v_created_at
         FROM rules r JOIN rule_versions v ON v.id = r.active_version_id
         WHERE r.task_id = ? LIMIT 1`,
      )
      .get(taskId) as SqlRow | undefined;
    if (!row) return null;
    return {
      rule: {
        id: String(row.r_id),
        taskId: String(row.task_id),
        name: String(row.name),
        activeVersionId: String(row.active_version_id),
        createdAt: String(row.r_created_at),
        updatedAt: String(row.updated_at),
      },
      version: {
        id: String(row.v_id),
        ruleId: String(row.rule_id),
        version: Number(row.version),
        definition: normalizeCrawlPlan(parseJson(row.definition)),
        generatedBy: row.generated_by as GeneratedBy,
        createdAt: String(row.v_created_at),
      },
    };
  }

  async createRun(taskId: string): Promise<CrawlRun> {
    return this.write(() =>
      this.sqlite.transaction(() => {
        const id = crypto.randomUUID();
        const createdAt = now();
        this.sqlite
          .prepare(
            `INSERT INTO runs(id,task_id,status,request_count,record_count,browser_used,ai_used,metadata,created_at)
             VALUES (?,?,'queued',0,0,0,0,'{}',?)`,
          )
          .run(id, taskId, createdAt);
        this.appendEventSync({
          type: 'run.queued',
          aggregateType: 'run',
          aggregateId: id,
          payload: { taskId },
        });
        return runRow(this.sqlite.prepare('SELECT * FROM runs WHERE id = ?').get(id) as SqlRow);
      })(),
    );
  }

  async listRuns(taskId: string): Promise<CrawlRun[]> {
    return (
      this.sqlite
        .prepare('SELECT * FROM runs WHERE task_id = ? ORDER BY created_at DESC')
        .all(taskId) as SqlRow[]
    ).map(runRow);
  }

  async getRun(id: string): Promise<CrawlRun | null> {
    const row = this.sqlite.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
      SqlRow | undefined;
    return row ? runRow(row) : null;
  }

  async startRun(runId: string, taskId: string): Promise<boolean> {
    return this.write(() =>
      this.sqlite.transaction(() => {
        const changed = this.sqlite
          .prepare(
            "UPDATE runs SET status='running',started_at=?,error=NULL WHERE id=? AND task_id=? AND status='queued'",
          )
          .run(now(), runId, taskId).changes;
        if (!changed) return false;
        this.sqlite.prepare("UPDATE runs SET phase='starting',progress=0.02 WHERE id=?").run(runId);
        this.sqlite
          .prepare("UPDATE tasks SET status='running',updated_at=? WHERE id=?")
          .run(now(), taskId);
        this.appendEventSync({
          type: 'run.running',
          aggregateType: 'run',
          aggregateId: runId,
          payload: { taskId },
        });
        return true;
      })(),
    );
  }

  async completeRun(runId: string, taskId: string, outcome: RunSuccessOutcome): Promise<void> {
    await this.write(() =>
      this.sqlite.transaction(() => this.completeRunSync(runId, taskId, outcome))(),
    );
  }

  async failRun(
    runId: string,
    taskId: string,
    error: string,
    code = 'CRAWLER_ERROR',
  ): Promise<void> {
    await this.write(() =>
      this.sqlite.transaction(() => {
        this.sqlite
          .prepare(
            "UPDATE runs SET status='failed',finished_at=?,error=?,error_code=?,phase='failed',progress=1,metadata=? WHERE id=?",
          )
          .run(now(), error, code, JSON.stringify({ errorCode: code }), runId);
        this.sqlite
          .prepare("UPDATE tasks SET status='failed',updated_at=? WHERE id=?")
          .run(now(), taskId);
        this.appendEventSync({
          type: 'run.failed',
          aggregateType: 'run',
          aggregateId: runId,
          payload: { taskId, code, error },
        });
      })(),
    );
  }

  async cancelRun(runId: string): Promise<CrawlRun | null> {
    return this.write(() =>
      this.sqlite.transaction(() => {
        const existing = this.sqlite.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as
          SqlRow | undefined;
        if (!existing || !['queued', 'running'].includes(String(existing.status))) return null;
        this.sqlite
          .prepare(
            "UPDATE runs SET status='canceled',finished_at=?,error='Canceled by user',error_code='CANCELED',phase='canceled',progress=1 WHERE id=?",
          )
          .run(now(), runId);
        this.sqlite
          .prepare("UPDATE tasks SET status='ready',updated_at=? WHERE id=?")
          .run(now(), existing.task_id);
        this.appendEventSync({
          type: 'run.canceled',
          aggregateType: 'run',
          aggregateId: runId,
          payload: { taskId: existing.task_id },
        });
        return runRow(this.sqlite.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as SqlRow);
      })(),
    );
  }

  async requestRunCancellation(runId: string): Promise<CrawlRun | null> {
    return this.write(() => {
      const changed = this.sqlite
        .prepare(
          "UPDATE runs SET cancel_requested_at=?,phase='canceling' WHERE id=? AND status IN ('queued','running')",
        )
        .run(now(), runId).changes;
      const row = this.sqlite.prepare('SELECT * FROM runs WHERE id=?').get(runId) as
        SqlRow | undefined;
      return changed && row ? runRow(row) : null;
    });
  }

  async setRunDeliveryStatus(runId: string, status: CrawlRun['deliveryStatus']): Promise<void> {
    await this.write(() => {
      this.sqlite.prepare('UPDATE runs SET delivery_status=? WHERE id=?').run(status, runId);
    });
  }

  async listRecords(runId: string, cursor: string | undefined, limit: number): Promise<RecordPage> {
    const offset = cursor ? Number.parseInt(Buffer.from(cursor, 'base64url').toString(), 10) : 0;
    const rows = this.sqlite
      .prepare('SELECT * FROM records WHERE run_id = ? ORDER BY created_at,id LIMIT ? OFFSET ?')
      .all(runId, limit + 1, Number.isFinite(offset) ? offset : 0) as SqlRow[];
    return {
      items: rows.slice(0, limit).map(recordRow),
      nextCursor:
        rows.length > limit ? Buffer.from(String(offset + limit)).toString('base64url') : null,
    };
  }

  async recordData(runId: string): Promise<Array<Record<string, unknown>>> {
    return (
      this.sqlite
        .prepare('SELECT data FROM records WHERE run_id = ? ORDER BY created_at,id')
        .all(runId) as SqlRow[]
    ).map((row) => parseJson(row.data));
  }

  private projectDatasetSync(
    taskId: string,
    runId: string,
    settings: DatasetSettings,
    records: Array<{ sourceUrl: string; data: Record<string, unknown> }>,
  ): DatasetStats {
    const timestamp = now();
    let dataset = this.sqlite.prepare('SELECT * FROM datasets WHERE task_id=?').get(taskId) as
      SqlRow | undefined;
    if (!dataset) {
      const id = crypto.randomUUID();
      this.sqlite
        .prepare(
          'INSERT INTO datasets(id,task_id,settings,current_count,created_at,updated_at) VALUES (?,?,?,0,?,?)',
        )
        .run(id, taskId, JSON.stringify(settings), timestamp, timestamp);
      dataset = this.sqlite.prepare('SELECT * FROM datasets WHERE id=?').get(id) as SqlRow;
    } else {
      this.sqlite
        .prepare('UPDATE datasets SET settings=?,updated_at=? WHERE id=?')
        .run(JSON.stringify(settings), timestamp, dataset.id);
    }
    const datasetId = String(dataset.id);
    const stats: DatasetStats = { added: 0, updated: 0, removed: 0, unchanged: 0, current: 0 };
    const normalized = new Map<
      string,
      { sourceUrl: string; data: Record<string, unknown>; hash: string }
    >();
    records.forEach((record, index) => {
      const baseKey = recordKey(record.data, settings);
      const key = settings.mode === 'append' ? `${runId}:${baseKey}:${index}` : baseKey;
      normalized.set(key, { ...record, hash: contentHash(record.data) });
    });
    for (const [key, record] of normalized) {
      const existing = this.sqlite
        .prepare('SELECT * FROM dataset_records WHERE dataset_id=? AND record_key=?')
        .get(datasetId, key) as SqlRow | undefined;
      if (!existing) {
        const id = crypto.randomUUID();
        this.sqlite
          .prepare(
            `INSERT INTO dataset_records(
                  id,dataset_id,task_id,record_key,source_url,data,content_hash,removed,
                  first_run_id,last_run_id,first_seen_at,last_seen_at
                ) VALUES (?,?,?,?,?,?,?,0,?,?,?,?)`,
          )
          .run(
            id,
            datasetId,
            taskId,
            key,
            record.sourceUrl,
            JSON.stringify(record.data),
            record.hash,
            runId,
            runId,
            timestamp,
            timestamp,
          );
        this.sqlite
          .prepare(
            'INSERT INTO record_changes(id,dataset_id,dataset_record_id,run_id,type,before,after,created_at) VALUES (?,?,?,?,?,?,?,?)',
          )
          .run(
            crypto.randomUUID(),
            datasetId,
            id,
            runId,
            'added',
            null,
            JSON.stringify(record.data),
            timestamp,
          );
        stats.added += 1;
      } else if (String(existing.content_hash) !== record.hash || Boolean(existing.removed)) {
        const before = parseJson<Record<string, unknown>>(existing.data);
        this.sqlite
          .prepare(
            `UPDATE dataset_records SET source_url=?,data=?,content_hash=?,removed=0,
                  last_run_id=?,last_seen_at=? WHERE id=?`,
          )
          .run(
            record.sourceUrl,
            JSON.stringify(record.data),
            record.hash,
            runId,
            timestamp,
            existing.id,
          );
        this.sqlite
          .prepare(
            'INSERT INTO record_changes(id,dataset_id,dataset_record_id,run_id,type,before,after,created_at) VALUES (?,?,?,?,?,?,?,?)',
          )
          .run(
            crypto.randomUUID(),
            datasetId,
            existing.id,
            runId,
            'updated',
            JSON.stringify(before),
            JSON.stringify(record.data),
            timestamp,
          );
        stats.updated += 1;
      } else {
        this.sqlite
          .prepare('UPDATE dataset_records SET removed=0,last_run_id=?,last_seen_at=? WHERE id=?')
          .run(runId, timestamp, existing.id);
        stats.unchanged += 1;
      }
    }
    if (settings.mode === 'snapshot' && settings.detectRemoved) {
      const stale = this.sqlite
        .prepare(
          'SELECT * FROM dataset_records WHERE dataset_id=? AND removed=0 AND (last_run_id IS NULL OR last_run_id<>?)',
        )
        .all(datasetId, runId) as SqlRow[];
      for (const row of stale) {
        this.sqlite.prepare('UPDATE dataset_records SET removed=1 WHERE id=?').run(row.id);
        this.sqlite
          .prepare(
            'INSERT INTO record_changes(id,dataset_id,dataset_record_id,run_id,type,before,after,created_at) VALUES (?,?,?,?,?,?,?,?)',
          )
          .run(
            crypto.randomUUID(),
            datasetId,
            row.id,
            runId,
            'removed',
            String(row.data),
            null,
            timestamp,
          );
        stats.removed += 1;
      }
    }
    const count = this.sqlite
      .prepare('SELECT COUNT(*) AS count FROM dataset_records WHERE dataset_id=? AND removed=0')
      .get(datasetId) as SqlRow;
    stats.current = Number(count.count);
    this.sqlite
      .prepare('UPDATE datasets SET current_count=?,updated_at=? WHERE id=?')
      .run(stats.current, timestamp, datasetId);
    this.sqlite
      .prepare('UPDATE runs SET dataset_stats=? WHERE id=?')
      .run(JSON.stringify(stats), runId);
    this.appendEventSync({
      type: 'dataset.projected',
      aggregateType: 'task',
      aggregateId: taskId,
      payload: { runId, ...stats },
    });
    return stats;
  }

  async projectDataset(
    taskId: string,
    runId: string,
    settings: DatasetSettings,
    records: Array<{ sourceUrl: string; data: Record<string, unknown> }>,
  ): Promise<DatasetStats> {
    return this.write(() =>
      this.sqlite.transaction(() => this.projectDatasetSync(taskId, runId, settings, records))(),
    );
  }

  async commitRunSuccess(
    runId: string,
    taskId: string,
    settings: DatasetSettings,
    datasetRecords: Array<{ sourceUrl: string; data: Record<string, unknown> }>,
    outcome: RunSuccessOutcome,
  ): Promise<DatasetStats> {
    return this.write(() =>
      this.sqlite.transaction(() => {
        const stats = this.projectDatasetSync(taskId, runId, settings, datasetRecords);
        this.completeRunSync(
          runId,
          taskId,
          {
            ...outcome,
            metadata: { ...outcome.metadata, datasetStats: stats },
          },
          settings,
        );
        return stats;
      })(),
    );
  }

  async applyRetention(taskId: string, policy: RetentionPolicy) {
    return this.write(() => {
      const runs = this.sqlite
        .prepare(
          "SELECT id,created_at FROM runs WHERE task_id=? AND status NOT IN ('queued','running') ORDER BY created_at DESC,id DESC",
        )
        .all(taskId) as SqlRow[];
      const runCutoff = policy.runDays
        ? new Date(Date.now() - policy.runDays * 86_400_000).toISOString()
        : null;
      const candidates = runs.filter(
        (row, index) =>
          (policy.maxRuns !== null && index >= policy.maxRuns) ||
          (runCutoff !== null && String(row.created_at) < runCutoff),
      );
      const deletable = candidates.map((row) => String(row.id));

      const artifactCutoff = policy.artifactDays
        ? new Date(Date.now() - policy.artifactDays * 86_400_000).toISOString()
        : null;
      const artifactRows = this.sqlite
        .prepare(
          `SELECT a.id,a.run_id,a.storage_key,a.created_at FROM artifacts a JOIN runs r ON r.id=a.run_id
           WHERE r.task_id=?`,
        )
        .all(taskId) as SqlRow[];
      const runIds = new Set(deletable);
      const artifactsToDelete = artifactRows.filter(
        (row) =>
          runIds.has(String(row.run_id)) ||
          (artifactCutoff !== null && String(row.created_at) < artifactCutoff),
      );
      const deleteArtifact = this.sqlite.prepare('DELETE FROM artifacts WHERE id=?');
      for (const row of artifactsToDelete) deleteArtifact.run(row.id);

      let deletedLogs = 0;
      if (policy.logDays !== null) {
        const cutoff = new Date(Date.now() - policy.logDays * 86_400_000).toISOString();
        deletedLogs = this.sqlite
          .prepare(
            'DELETE FROM run_logs WHERE created_at < ? AND run_id IN (SELECT id FROM runs WHERE task_id=?)',
          )
          .run(cutoff, taskId).changes;
      }
      const deleteRun = this.sqlite.prepare('DELETE FROM runs WHERE id=?');
      let deletedRuns = 0;
      for (const id of deletable) deletedRuns += deleteRun.run(id).changes;
      return {
        deletedRuns,
        deletedLogs,
        deletedArtifacts: artifactsToDelete.length,
        retainedReferencedRuns: 0,
        artifactStorageKeys: artifactsToDelete.map((row) => String(row.storage_key)),
      };
    });
  }

  async listDatasetRecords(
    taskId: string,
    cursor: string | undefined,
    limit: number,
    options: {
      includeRemoved?: boolean;
      query?: string;
      filter?: Record<string, string | number | boolean | null>;
    } = {},
  ): Promise<DatasetRecordPage> {
    const clauses = ['task_id=?'];
    const parameters: unknown[] = [taskId];
    if (!options.includeRemoved) clauses.push('removed=0');
    if (options.query) {
      clauses.push('(data LIKE ? OR source_url LIKE ?)');
      parameters.push(`%${options.query}%`, `%${options.query}%`);
    }
    for (const [field, value] of Object.entries(options.filter ?? {})) {
      const path = `$.${field}`;
      if (value === null) {
        clauses.push("json_type(data, ?) = 'null'");
        parameters.push(path);
      } else {
        clauses.push('json_extract(data, ?) = ?');
        parameters.push(path, value);
      }
    }
    if (cursor) {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as {
        lastSeenAt: string;
        id: string;
      };
      clauses.push('(last_seen_at < ? OR (last_seen_at = ? AND id < ?))');
      parameters.push(decoded.lastSeenAt, decoded.lastSeenAt, decoded.id);
    }
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM dataset_records WHERE ${clauses.join(' AND ')} ORDER BY last_seen_at DESC,id DESC LIMIT ?`,
      )
      .all(...parameters, limit + 1) as SqlRow[];
    const dataset = this.sqlite.prepare('SELECT * FROM datasets WHERE task_id=?').get(taskId) as
      SqlRow | undefined;
    const latest = this.sqlite
      .prepare('SELECT dataset_stats FROM runs WHERE task_id=? ORDER BY created_at DESC LIMIT 1')
      .get(taskId) as SqlRow | undefined;
    return {
      items: rows.slice(0, limit).map(datasetRecordRow),
      nextCursor:
        rows.length > limit
          ? Buffer.from(
              JSON.stringify({
                lastSeenAt: String(rows[limit - 1]!.last_seen_at),
                id: String(rows[limit - 1]!.id),
              }),
            ).toString('base64url')
          : null,
      stats: latest
        ? parseJson(latest.dataset_stats)
        : {
            added: 0,
            updated: 0,
            removed: 0,
            unchanged: 0,
            current: Number(dataset?.current_count ?? 0),
          },
    };
  }

  async listRecordChanges(
    taskId: string,
    cursor: string | undefined,
    limit: number,
    runId?: string,
  ): Promise<RecordChangePage> {
    const clauses = ['d.task_id=?'];
    const parameters: unknown[] = [taskId];
    if (runId) {
      clauses.push('c.run_id=?');
      parameters.push(runId);
    }
    if (cursor) {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as {
        createdAt: string;
        id: string;
      };
      clauses.push('(c.created_at < ? OR (c.created_at = ? AND c.id < ?))');
      parameters.push(decoded.createdAt, decoded.createdAt, decoded.id);
    }
    const rows = this.sqlite
      .prepare(
        `SELECT c.* FROM record_changes c JOIN datasets d ON d.id=c.dataset_id
         WHERE ${clauses.join(' AND ')}
         ORDER BY c.created_at DESC,c.id DESC LIMIT ?`,
      )
      .all(...parameters, limit + 1) as SqlRow[];
    return {
      items: rows.slice(0, limit).map(recordChangeRow),
      nextCursor:
        rows.length > limit
          ? Buffer.from(
              JSON.stringify({
                createdAt: String(rows[limit - 1]!.created_at),
                id: String(rows[limit - 1]!.id),
              }),
            ).toString('base64url')
          : null,
    };
  }

  async diffRunRecords(
    taskId: string,
    fromRunId: string,
    toRunId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<DatasetDiffPage> {
    const after = cursor ? Buffer.from(cursor, 'base64url').toString('utf8') : '';
    const commonTableExpression = `
      WITH before_ranked AS (
        SELECT COALESCE(record_key,data) AS record_key,data,
          COALESCE(content_hash,data) AS content_hash,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(record_key,data) ORDER BY created_at DESC,id DESC
          ) AS rank
        FROM records WHERE task_id=? AND run_id=?
      ), before_records AS (
        SELECT record_key,data,content_hash FROM before_ranked WHERE rank=1
      ), after_ranked AS (
        SELECT COALESCE(record_key,data) AS record_key,data,
          COALESCE(content_hash,data) AS content_hash,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(record_key,data) ORDER BY created_at DESC,id DESC
          ) AS rank
        FROM records WHERE task_id=? AND run_id=?
      ), after_records AS (
        SELECT record_key,data,content_hash FROM after_ranked WHERE rank=1
      ), diff AS (
        SELECT before_records.record_key AS record_key,
          CASE WHEN after_records.record_key IS NULL THEN 'removed' ELSE 'updated' END AS change_type,
          before_records.data AS before_data,after_records.data AS after_data
        FROM before_records
        LEFT JOIN after_records ON after_records.record_key=before_records.record_key
        WHERE after_records.record_key IS NULL
          OR before_records.content_hash<>after_records.content_hash
        UNION ALL
        SELECT after_records.record_key AS record_key,'added' AS change_type,
          NULL AS before_data,after_records.data AS after_data
        FROM after_records
        LEFT JOIN before_records ON before_records.record_key=after_records.record_key
        WHERE before_records.record_key IS NULL
      )`;
    const parameters = [taskId, fromRunId, taskId, toRunId];
    const rows = this.sqlite
      .prepare(
        `${commonTableExpression}
         SELECT * FROM diff WHERE record_key>? ORDER BY record_key LIMIT ?`,
      )
      .all(...parameters, after, limit + 1) as SqlRow[];
    const stats = this.sqlite
      .prepare(
        `${commonTableExpression}
         SELECT
           COALESCE(SUM(change_type='added'),0) AS added,
           COALESCE(SUM(change_type='updated'),0) AS updated,
           COALESCE(SUM(change_type='removed'),0) AS removed
         FROM diff`,
      )
      .get(...parameters) as SqlRow;
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => ({
        recordKey: String(row.record_key),
        type: row.change_type as 'added' | 'updated' | 'removed',
        before: row.before_data === null ? null : parseJson(row.before_data),
        after: row.after_data === null ? null : parseJson(row.after_data),
      })),
      nextCursor:
        rows.length > limit
          ? Buffer.from(String(page.at(-1)!.record_key), 'utf8').toString('base64url')
          : null,
      stats: {
        added: Number(stats.added),
        updated: Number(stats.updated),
        removed: Number(stats.removed),
      },
    };
  }

  async appendRunLog(
    entry: Omit<RunLogEntry, 'id' | 'sequence' | 'createdAt'>,
  ): Promise<RunLogEntry> {
    return this.write(() => {
      const id = crypto.randomUUID();
      const createdAt = now();
      const row = this.sqlite
        .prepare('SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM run_logs WHERE run_id=?')
        .get(entry.runId) as SqlRow;
      this.sqlite
        .prepare(
          'INSERT INTO run_logs(id,run_id,sequence,level,phase,message,url,error_code,metadata,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          entry.runId,
          row.sequence,
          entry.level,
          entry.phase,
          entry.message,
          entry.url,
          entry.errorCode,
          JSON.stringify(entry.metadata),
          createdAt,
        );
      const progress = entry.metadata.progress;
      this.sqlite
        .prepare(
          `UPDATE runs SET phase=?,progress=COALESCE(?,progress),
            warning_count=warning_count+? WHERE id=?`,
        )
        .run(
          entry.phase,
          typeof progress === 'number' ? progress : null,
          entry.level === 'warn' ? 1 : 0,
          entry.runId,
        );
      return runLogRow(this.sqlite.prepare('SELECT * FROM run_logs WHERE id=?').get(id) as SqlRow);
    });
  }

  async listRunLogs(runId: string, cursor: string | undefined, limit: number): Promise<RunLogPage> {
    const sequence = cursor ? Number.parseInt(cursor, 10) : 0;
    const rows = this.sqlite
      .prepare('SELECT * FROM run_logs WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?')
      .all(runId, sequence, limit + 1) as SqlRow[];
    return {
      items: rows.slice(0, limit).map(runLogRow),
      nextCursor: rows.length > limit ? String(rows[limit - 1]!.sequence) : null,
    };
  }

  async appendRunRequest(
    entry: Omit<RunRequestEntry, 'id' | 'createdAt'>,
  ): Promise<RunRequestEntry> {
    return this.write(() => {
      const id = crypto.randomUUID();
      const createdAt = now();
      this.sqlite
        .prepare(
          'INSERT INTO run_requests(id,run_id,url,kind,status,status_code,duration_ms,error_code,error,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
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
          createdAt,
        );
      return runRequestRow(
        this.sqlite.prepare('SELECT * FROM run_requests WHERE id=?').get(id) as SqlRow,
      );
    });
  }

  async listRunRequests(
    runId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<RunRequestPage> {
    const offset = cursor ? Number.parseInt(Buffer.from(cursor, 'base64url').toString(), 10) : 0;
    const rows = this.sqlite
      .prepare('SELECT * FROM run_requests WHERE run_id=? ORDER BY created_at,id LIMIT ? OFFSET ?')
      .all(runId, limit + 1, Number.isFinite(offset) ? offset : 0) as SqlRow[];
    return {
      items: rows.slice(0, limit).map(runRequestRow),
      nextCursor:
        rows.length > limit ? Buffer.from(String(offset + limit)).toString('base64url') : null,
    };
  }

  async createOutputDestination(
    input: Pick<OutputDestination, 'name' | 'type' | 'config' | 'credentialRef' | 'enabled'>,
  ): Promise<OutputDestination> {
    return this.write(() => {
      const id = crypto.randomUUID();
      const timestamp = now();
      this.sqlite
        .prepare(
          'INSERT INTO output_destinations(id,name,type,config,credential_ref,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          input.name,
          input.type,
          JSON.stringify(input.config),
          input.credentialRef,
          Number(input.enabled),
          timestamp,
          timestamp,
        );
      return outputDestinationRow(
        this.sqlite.prepare('SELECT * FROM output_destinations WHERE id=?').get(id) as SqlRow,
      );
    });
  }

  async listOutputDestinations(): Promise<OutputDestination[]> {
    return (
      this.sqlite
        .prepare('SELECT * FROM output_destinations ORDER BY created_at DESC')
        .all() as SqlRow[]
    ).map(outputDestinationRow);
  }

  async getOutputDestination(id: string): Promise<OutputDestination | null> {
    const row = this.sqlite.prepare('SELECT * FROM output_destinations WHERE id=?').get(id) as
      SqlRow | undefined;
    return row ? outputDestinationRow(row) : null;
  }

  async updateOutputDestination(
    id: string,
    input: Partial<Pick<OutputDestination, 'name' | 'config' | 'credentialRef' | 'enabled'>>,
  ): Promise<OutputDestination | null> {
    return this.write(() => {
      const existing = this.sqlite
        .prepare('SELECT * FROM output_destinations WHERE id=?')
        .get(id) as SqlRow | undefined;
      if (!existing) return null;
      const current = outputDestinationRow(existing);
      this.sqlite
        .prepare(
          'UPDATE output_destinations SET name=?,config=?,credential_ref=?,enabled=?,updated_at=? WHERE id=?',
        )
        .run(
          input.name ?? current.name,
          JSON.stringify(input.config ?? current.config),
          input.credentialRef === undefined ? current.credentialRef : input.credentialRef,
          Number(input.enabled ?? current.enabled),
          now(),
          id,
        );
      return outputDestinationRow(
        this.sqlite.prepare('SELECT * FROM output_destinations WHERE id=?').get(id) as SqlRow,
      );
    });
  }

  async deleteOutputDestination(id: string): Promise<boolean> {
    return this.write(() =>
      this.sqlite.transaction(() => {
        const deleted = this.sqlite
          .prepare('DELETE FROM output_destinations WHERE id=?')
          .run(id).changes;
        if (!deleted) return false;
        const rows = this.sqlite.prepare('SELECT id,output_bindings FROM tasks').all() as SqlRow[];
        const update = this.sqlite.prepare(
          'UPDATE tasks SET output_bindings=?,revision=revision+1,updated_at=? WHERE id=?',
        );
        for (const row of rows) {
          const current = parseJson<string[]>(row.output_bindings);
          if (current.includes(id)) {
            update.run(JSON.stringify(current.filter((binding) => binding !== id)), now(), row.id);
          }
        }
        return true;
      })(),
    );
  }

  async createDeliveryAttempt(
    input: Pick<DeliveryAttempt, 'destinationId' | 'taskId' | 'runId'>,
  ): Promise<DeliveryAttempt> {
    return this.write(() => {
      const id = crypto.randomUUID();
      const timestamp = now();
      this.sqlite
        .prepare(
          "INSERT INTO delivery_attempts(id,destination_id,task_id,run_id,status,attempt,created_at,updated_at) VALUES (?,?,?,?,'pending',1,?,?)",
        )
        .run(id, input.destinationId, input.taskId, input.runId, timestamp, timestamp);
      return deliveryAttemptRow(
        this.sqlite.prepare('SELECT * FROM delivery_attempts WHERE id=?').get(id) as SqlRow,
      );
    });
  }

  async updateDeliveryAttempt(
    id: string,
    input: Partial<
      Pick<DeliveryAttempt, 'status' | 'attempt' | 'responseStatus' | 'error' | 'nextAttemptAt'>
    >,
  ): Promise<DeliveryAttempt | null> {
    return this.write(() => {
      const row = this.sqlite.prepare('SELECT * FROM delivery_attempts WHERE id=?').get(id) as
        SqlRow | undefined;
      if (!row) return null;
      const current = deliveryAttemptRow(row);
      this.sqlite
        .prepare(
          'UPDATE delivery_attempts SET status=?,attempt=?,response_status=?,error=?,next_attempt_at=?,updated_at=? WHERE id=?',
        )
        .run(
          input.status ?? current.status,
          input.attempt ?? current.attempt,
          input.responseStatus === undefined ? current.responseStatus : input.responseStatus,
          input.error === undefined ? current.error : input.error,
          input.nextAttemptAt === undefined ? current.nextAttemptAt : input.nextAttemptAt,
          now(),
          id,
        );
      return deliveryAttemptRow(
        this.sqlite.prepare('SELECT * FROM delivery_attempts WHERE id=?').get(id) as SqlRow,
      );
    });
  }

  async listDeliveryAttempts(runId?: string): Promise<DeliveryAttempt[]> {
    const rows = runId
      ? (this.sqlite
          .prepare('SELECT * FROM delivery_attempts WHERE run_id=? ORDER BY created_at DESC')
          .all(runId) as SqlRow[])
      : (this.sqlite
          .prepare('SELECT * FROM delivery_attempts ORDER BY created_at DESC')
          .all() as SqlRow[]);
    return rows.map(deliveryAttemptRow);
  }

  async createApiToken(
    input: Pick<ApiToken, 'name' | 'taskIds' | 'rateLimitPerMinute' | 'expiresAt'> & {
      tokenHash: string;
    },
  ): Promise<ApiToken> {
    return this.write(() => {
      const id = crypto.randomUUID();
      const createdAt = now();
      this.sqlite
        .prepare(
          'INSERT INTO api_tokens(id,name,token_hash,task_ids,rate_limit_per_minute,expires_at,revoked_at,created_at) VALUES (?,?,?,?,?,?,NULL,?)',
        )
        .run(
          id,
          input.name,
          input.tokenHash,
          JSON.stringify(input.taskIds),
          input.rateLimitPerMinute,
          input.expiresAt,
          createdAt,
        );
      return apiTokenRow(
        this.sqlite.prepare('SELECT * FROM api_tokens WHERE id=?').get(id) as SqlRow,
      );
    });
  }

  async listApiTokens(): Promise<ApiToken[]> {
    return (
      this.sqlite.prepare('SELECT * FROM api_tokens ORDER BY created_at DESC').all() as SqlRow[]
    ).map(apiTokenRow);
  }

  async findApiToken(tokenHash: string): Promise<ApiToken | null> {
    const row = this.sqlite
      .prepare('SELECT * FROM api_tokens WHERE token_hash=? AND revoked_at IS NULL')
      .get(tokenHash) as SqlRow | undefined;
    return row ? apiTokenRow(row) : null;
  }

  async revokeApiToken(id: string): Promise<boolean> {
    return this.write(
      () =>
        this.sqlite
          .prepare('UPDATE api_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL')
          .run(now(), id).changes > 0,
    );
  }

  async createRuleRepairProposal(
    input: Pick<RuleRepairProposal, 'taskId' | 'ruleId' | 'runId' | 'definition' | 'explanation'>,
  ): Promise<RuleRepairProposal> {
    return this.write(() => {
      const id = crypto.randomUUID();
      this.sqlite
        .prepare(
          "INSERT INTO rule_repair_proposals(id,task_id,rule_id,run_id,definition,explanation,status,created_at) VALUES (?,?,?,?,?,?,'pending',?)",
        )
        .run(
          id,
          input.taskId,
          input.ruleId,
          input.runId,
          JSON.stringify(input.definition),
          input.explanation,
          now(),
        );
      return repairProposalRow(
        this.sqlite.prepare('SELECT * FROM rule_repair_proposals WHERE id=?').get(id) as SqlRow,
      );
    });
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
    return this.write(() => {
      const changed = this.sqlite
        .prepare('UPDATE rule_repair_proposals SET status=? WHERE id=?')
        .run(status, id).changes;
      if (!changed) return null;
      return repairProposalRow(
        this.sqlite.prepare('SELECT * FROM rule_repair_proposals WHERE id=?').get(id) as SqlRow,
      );
    });
  }

  async markRuleRepairProposalTested(id: string): Promise<RuleRepairProposal | null> {
    return this.write(() => {
      const changed = this.sqlite
        .prepare("UPDATE rule_repair_proposals SET tested_at=? WHERE id=? AND status='pending'")
        .run(now(), id).changes;
      if (!changed) return null;
      return repairProposalRow(
        this.sqlite.prepare('SELECT * FROM rule_repair_proposals WHERE id=?').get(id) as SqlRow,
      );
    });
  }

  async appendEvent(event: Omit<DomainEvent, 'id' | 'cursor' | 'createdAt'>): Promise<DomainEvent> {
    return this.write(() => this.appendEventSync(event));
  }

  async listEvents(after: number, limit: number): Promise<DomainEventPage> {
    const items = (
      this.sqlite
        .prepare('SELECT * FROM domain_events WHERE cursor > ? ORDER BY cursor LIMIT ?')
        .all(after, limit) as SqlRow[]
    ).map(eventRow);
    return { items, nextCursor: items.at(-1)?.cursor ?? after };
  }

  async getIdempotency(scope: string, key: string) {
    const row = this.sqlite
      .prepare('SELECT fingerprint,response FROM idempotency_keys WHERE scope=? AND key=?')
      .get(scope, key) as SqlRow | undefined;
    return row ? { fingerprint: String(row.fingerprint), response: parseJson(row.response) } : null;
  }

  async putIdempotency(
    scope: string,
    key: string,
    fingerprint: string,
    response: unknown,
  ): Promise<void> {
    await this.write(() => {
      this.sqlite
        .prepare(
          'INSERT INTO idempotency_keys(scope,key,fingerprint,response,created_at) VALUES (?,?,?,?,?)',
        )
        .run(scope, key, fingerprint, JSON.stringify(response), now());
    });
  }

  async putArtifact(
    descriptor: Omit<ArtifactDescriptor, 'id' | 'createdAt'> & { storageKey: string },
  ): Promise<ArtifactDescriptor> {
    return this.write(() => {
      const id = crypto.randomUUID();
      const createdAt = now();
      this.sqlite
        .prepare(
          'INSERT INTO artifacts(id,run_id,format,filename,content_type,size,storage_key,created_at) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          descriptor.runId,
          descriptor.format,
          descriptor.filename,
          descriptor.contentType,
          descriptor.size,
          descriptor.storageKey,
          createdAt,
        );
      return { ...descriptor, id, createdAt };
    });
  }

  async getArtifact(id: string): Promise<(ArtifactDescriptor & { storageKey: string }) | null> {
    const row = this.sqlite.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as
      SqlRow | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      runId: String(row.run_id),
      format: row.format as ArtifactDescriptor['format'],
      filename: String(row.filename),
      contentType: String(row.content_type),
      size: Number(row.size),
      storageKey: String(row.storage_key),
      createdAt: String(row.created_at),
    };
  }

  async enqueueRuntimeJob(job: RuntimeJob): Promise<void> {
    await this.write(() => {
      const timestamp = now();
      this.sqlite
        .prepare(
          "INSERT INTO runtime_jobs(id,task_id,run_id,state,scheduled,available_at,created_at,updated_at) VALUES (?,?,?,'queued',?,?,?,?)",
        )
        .run(
          job.id,
          job.taskId,
          job.runId ?? null,
          Number(job.scheduled ?? false),
          timestamp,
          timestamp,
          timestamp,
        );
    });
  }

  async claimRuntimeJob(): Promise<RuntimeJob | null> {
    return this.write(() =>
      this.sqlite.transaction(() => {
        const row = this.sqlite
          .prepare(
            "SELECT * FROM runtime_jobs WHERE state='queued' AND available_at <= ? ORDER BY created_at LIMIT 1",
          )
          .get(now()) as SqlRow | undefined;
        if (!row) return null;
        this.sqlite
          .prepare(
            "UPDATE runtime_jobs SET state='running',updated_at=? WHERE id=? AND state='queued'",
          )
          .run(now(), row.id);
        return {
          id: String(row.id),
          taskId: String(row.task_id),
          ...(row.run_id ? { runId: String(row.run_id) } : {}),
          scheduled: Boolean(row.scheduled),
        };
      })(),
    );
  }

  async finishRuntimeJob(id: string): Promise<void> {
    await this.write(() => {
      this.sqlite.prepare('DELETE FROM runtime_jobs WHERE id = ?').run(id);
    });
  }

  async cancelRuntimeJob(runId: string): Promise<boolean> {
    return this.write(
      () =>
        this.sqlite
          .prepare("DELETE FROM runtime_jobs WHERE run_id = ? AND state='queued'")
          .run(runId).changes > 0,
    );
  }
}
