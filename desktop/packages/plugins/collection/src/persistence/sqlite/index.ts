import type { CollectionDraft } from '@zhiyun/shared';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  normalizeCrawlPlan,
  browserActionCacheSummarySchema,
  ZhiYunError,
  BROWSER_ROUND_BATCH_STRIDE,
  type CrawlBrowserPagination,
  type CrawlBrowserRound,
  type CrawlRun,
  type RuleRepairProposal,
  type RunLogEntry,
  type RunRequestEntry,
  type CrawlCheckpoint,
  type CrawlRequestCheckpoint,
  type CrawlRequestSeed,
  type CrawlRequestStage,
  type CrawlSitemapNode,
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
  StoredCrawlBatch,
  SavedCrawlResult,
  CrawlCleanupIntent,
} from '../../contracts/index.js';
import {
  collectionSqliteMigration001,
  collectionSqliteMigration002,
  collectionSqliteMigration003,
  collectionSqliteMigration004,
  collectionSqliteMigration005,
  collectionSqliteMigration006,
  collectionSqliteMigration007,
  collectionSqliteMigration008,
} from '../../migrations/sqlite/index.js';

type SqlRow = Record<string, unknown>;
const MIGRATIONS = [
  { id: '001-initial', sql: collectionSqliteMigration001, version: '1.0.0' },
  { id: '002-task-origin', sql: collectionSqliteMigration002, version: '1.1.0' },
  { id: '003-unified-drafts', sql: collectionSqliteMigration003, version: '1.2.0' },
  { id: '004-crawl-batches', sql: collectionSqliteMigration004, version: '1.3.0' },
  { id: '005-url-checkpoints', sql: collectionSqliteMigration005, version: '1.4.0' },
  { id: '006-sitemap-spool', sql: collectionSqliteMigration006, version: '1.5.0' },
  { id: '007-crawl-cleanup', sql: collectionSqliteMigration007, version: '1.6.0' },
  { id: '008-browser-rounds', sql: collectionSqliteMigration008, version: '1.7.0' },
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

  async createDraft(draft: CollectionDraft): Promise<CollectionDraft> {
    this.sqlite
      .prepare(
        'INSERT INTO collection_drafts(id,revision,content,updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING',
      )
      .run(draft.id, draft.revision, JSON.stringify(draft), draft.updatedAt);
    return (await this.getDraft(draft.id))!;
  }
  async getDraft(id: string): Promise<CollectionDraft | null> {
    const row = this.sqlite.prepare('SELECT content FROM collection_drafts WHERE id=?').get(id) as
      SqlRow | undefined;
    return row ? (JSON.parse(String(row.content)) as CollectionDraft) : null;
  }
  async listDrafts(): Promise<CollectionDraft[]> {
    return (
      this.sqlite
        .prepare(
          "SELECT content FROM collection_drafts WHERE json_extract(content,'$.status') <> 'committed' ORDER BY updated_at DESC,id DESC LIMIT 100",
        )
        .all() as SqlRow[]
    ).map((r) => JSON.parse(String(r.content)) as CollectionDraft);
  }
  async updateDraft(
    draft: CollectionDraft,
    expectedRevision: number,
  ): Promise<CollectionDraft | null> {
    const updated = { ...draft, revision: expectedRevision + 1, updatedAt: now() };
    const result = this.sqlite
      .prepare(
        'UPDATE collection_drafts SET revision=?,content=?,updated_at=? WHERE id=? AND revision=?',
      )
      .run(
        updated.revision,
        JSON.stringify(updated),
        updated.updatedAt,
        draft.id,
        expectedRevision,
      );
    return result.changes === 1 ? updated : null;
  }
  async deleteDraft(id: string, expectedRevision: number): Promise<boolean> {
    return (
      this.sqlite
        .prepare(
          "DELETE FROM collection_drafts WHERE id=? AND revision=? AND json_extract(content,'$.status')='editing'",
        )
        .run(id, expectedRevision).changes === 1
    );
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

  async listTasks(
    cursor?: string,
    limit = 100,
    options: NonNullable<Parameters<CollectionRepository['listTasks']>[2]> = {},
  ) {
    const pageSize = Math.min(Math.max(limit, 1), 500);
    const parameters: Array<string | number> = [];
    const bind = (value: string | number) => {
      parameters.push(value);
      return '?';
    };
    const clauses: string[] = [];
    if (options.query)
      clauses.push(`instr(lower(name || ' ' || start_url),${bind(options.query.toLowerCase())})>0`);
    if (options.status) clauses.push(`status=${bind(options.status)}`);
    if (options.includeManaged === false)
      clauses.push("json_extract(origin,'$.kind') <> 'managed'");
    const column =
      options.sort === 'name' ? 'name' : options.sort === 'createdAt' ? 'created_at' : 'updated_at';
    const direction = options.direction === 'asc' ? 'ASC' : 'DESC';
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const fingerprint = sha256(JSON.stringify(options));
    let offset = 0;
    if (cursor) {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (
        typeof parsed.at === 'string' &&
        Number.isFinite(Date.parse(parsed.at)) &&
        typeof parsed.id === 'string' &&
        (!options.sort || options.sort === 'updatedAt') &&
        options.direction !== 'asc'
      ) {
        const preceding = this.sqlite
          .prepare(
            `SELECT COUNT(*) AS total FROM tasks ${where} ${where ? 'AND' : 'WHERE'} (updated_at>? OR (updated_at=? AND id>=?))`,
          )
          .get(...parameters, parsed.at, parsed.at, parsed.id) as SqlRow;
        offset = Number(preceding.total);
      } else {
        if (
          parsed.query !== fingerprint ||
          !Number.isSafeInteger(parsed.offset) ||
          parsed.offset < 0
        )
          throw new Error('Query changed; restart pagination');
        offset = parsed.offset;
      }
    }
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM tasks ${where} ORDER BY ${column} ${direction},id ${direction} LIMIT ? OFFSET ?`,
      )
      .all(...parameters, pageSize + 1, offset) as SqlRow[];
    const count = this.sqlite
      .prepare(`SELECT COUNT(*) AS total FROM tasks ${where}`)
      .get(...parameters) as SqlRow;
    const items = rows.slice(0, pageSize).map(taskRow);
    return {
      items,
      totalCount: Number(count.total),
      nextCursor:
        rows.length > pageSize
          ? Buffer.from(JSON.stringify({ offset: offset + pageSize, query: fingerprint })).toString(
              'base64url',
            )
          : null,
    };
  }

  async taskSummaries(
    query?: string,
    ids?: readonly string[],
  ): Promise<Array<{ id: string; name: string }>> {
    const clauses: string[] = [];
    const params: string[] = [];
    if (query) {
      clauses.push("instr(lower(name || ' ' || start_url),?)>0");
      params.push(query.toLowerCase());
    }
    if (ids) {
      if (!ids.length) return [];
      clauses.push(`id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
    return (
      this.sqlite
        .prepare(
          `SELECT id,name FROM tasks ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}`,
        )
        .all(...params) as SqlRow[]
    ).map((r) => ({ id: String(r.id), name: String(r.name) }));
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

  async deleteTask(id: string, expectedRevision?: number): Promise<boolean> {
    return this.sqlite.transaction(() => {
      const task = this.sqlite.prepare('SELECT revision FROM tasks WHERE id=?').get(id) as
        SqlRow | undefined;
      if (!task || (expectedRevision !== undefined && Number(task.revision) !== expectedRevision))
        return false;
      // Survives the Run/session cascade, including a crash before filesystem cleanup.
      this.sqlite
        .prepare(
          "INSERT INTO collection_crawl_cleanup(run_id,task_id,reason,created_at,available_at) SELECT id,task_id,'deleted',?,? FROM runs WHERE task_id=? ON CONFLICT(run_id) DO UPDATE SET reason='deleted',available_at=excluded.available_at",
        )
        .run(now(), now(), id);
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
    identity?: { ruleId: string; versionId: string },
  ) {
    return this.sqlite.transaction(() => {
      if (identity) {
        const saved = this.sqlite
          .prepare('SELECT * FROM rules WHERE id=? AND task_id=?')
          .get(identity.ruleId, taskId) as SqlRow | undefined;
        if (saved)
          return {
            rule: ruleRow(saved),
            version: ruleVersionRow(
              this.sqlite
                .prepare('SELECT * FROM rule_versions WHERE id=?')
                .get(identity.versionId) as SqlRow,
            ),
          };
      }
      const timestamp = now();
      const ruleId = identity?.ruleId ?? randomUUID();
      const versionId = identity?.versionId ?? randomUUID();
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
    versionId?: string,
    expectedActiveVersionId?: string,
  ): Promise<RuleVersionRecord | null> {
    return this.sqlite.transaction(() => {
      if (versionId) {
        const saved = this.sqlite
          .prepare('SELECT * FROM rule_versions WHERE id=? AND rule_id=?')
          .get(versionId, ruleId) as SqlRow | undefined;
        if (saved) return ruleVersionRow(saved);
      }
      const rule = this.sqlite
        .prepare('SELECT * FROM rules WHERE id=? AND task_id=?')
        .get(ruleId, taskId) as SqlRow | undefined;
      if (!rule || (expectedActiveVersionId && rule.active_version_id !== expectedActiveVersionId))
        return null;
      const current = this.sqlite
        .prepare('SELECT MAX(version) AS version FROM rule_versions WHERE rule_id=?')
        .get(ruleId) as SqlRow;
      const version = Number(current.version ?? 0) + 1;
      const id = versionId ?? randomUUID();
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

  async createRun(
    taskId: string,
    runId?: string,
    metadata: Record<string, unknown> = {},
  ): Promise<CrawlRun> {
    if (runId) {
      const existing = await this.getRun(runId);
      if (existing) {
        if (existing.taskId !== taskId) throw new Error('Run identity conflicts');
        return existing;
      }
    }
    return this.sqlite.transaction(() => {
      if (runId) {
        const saved = this.sqlite
          .prepare('SELECT * FROM runs WHERE id=? AND task_id=?')
          .get(runId, taskId) as SqlRow | undefined;
        if (saved) return runRow(saved);
      }
      const id = runId ?? randomUUID();
      const timestamp = now();
      this.sqlite
        .prepare(
          `INSERT INTO runs(
             id,task_id,status,request_count,record_count,browser_used,ai_used,phase,progress,
             dataset_stats,delivery_status,warning_count,metadata,created_at
           ) VALUES (?,?,'queued',0,0,0,0,'queued',0,?,'idle',0,?,?)`,
        )
        .run(id, taskId, json(emptyStats()), json(metadata), timestamp);
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

  async beginCrawlSession(runId: string, fingerprint: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(fingerprint))
      throw new Error('VALIDATION: Invalid crawl fingerprint');
    this.sqlite.transaction(() => {
      const row = this.sqlite
        .prepare('SELECT fingerprint FROM collection_crawl_sessions WHERE run_id=?')
        .get(runId) as SqlRow | undefined;
      if (row) {
        if (row.fingerprint !== fingerprint)
          throw new Error('VALIDATION: Crawl configuration changed; start a new run');
        return;
      }
      this.sqlite
        .prepare(
          'INSERT INTO collection_crawl_sessions(run_id,fingerprint,created_at) VALUES (?,?,?)',
        )
        .run(runId, fingerprint, now());
    })();
  }

  async saveCrawlBatch(
    runId: string,
    fingerprint: string,
    batch: Omit<StoredCrawlBatch, 'ordinal'>,
  ): Promise<void> {
    if (
      !/^[a-f0-9]{64}$/.test(batch.id) ||
      !/^[a-f0-9]{64}$/.test(batch.requestId) ||
      !/^[a-f0-9]{64}$/.test(batch.checksum) ||
      !Number.isSafeInteger(batch.sequence) ||
      batch.sequence < 0 ||
      !Number.isSafeInteger(batch.rowCount) ||
      batch.rowCount < 0 ||
      batch.rowCount > 250 ||
      batch.storageKey !== `collection-batches/${runId}/list/${batch.id}.json`
    )
      throw new Error('VALIDATION: Invalid crawl batch');
    this.sqlite.transaction(() => {
      this.assertCrawlFingerprint(runId, fingerprint);
      const previous = this.sqlite
        .prepare('SELECT * FROM collection_crawl_batches WHERE run_id=? AND id=?')
        .get(runId, batch.id) as SqlRow | undefined;
      if (previous) {
        if (
          previous.checksum !== batch.checksum ||
          previous.storage_key !== batch.storageKey ||
          previous.request_id !== batch.requestId ||
          previous.sequence !== batch.sequence ||
          previous.row_count !== batch.rowCount
        )
          throw new Error('VALIDATION: Replayed list batch contents changed; start a new run');
        return;
      }
      this.sqlite
        .prepare(
          'INSERT INTO collection_crawl_batches(run_id,id,ordinal,request_id,sequence,storage_key,checksum,row_count) VALUES (?,?,(SELECT COALESCE(MAX(ordinal),0)+1 FROM collection_crawl_batches WHERE run_id=?),?,?,?,?,?)',
        )
        .run(
          runId,
          batch.id,
          runId,
          batch.requestId,
          batch.sequence,
          batch.storageKey,
          batch.checksum,
          batch.rowCount,
        );
    })();
  }

  async listCrawlBatches(
    runId: string,
    fingerprint: string,
    afterOrdinal = 0,
    requestId?: string,
  ): Promise<StoredCrawlBatch[]> {
    this.assertCrawlFingerprint(runId, fingerprint);
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM collection_crawl_batches WHERE run_id=? AND ordinal>? ${requestId ? 'AND request_id=?' : ''} ORDER BY ordinal LIMIT 100`,
      )
      .all(runId, afterOrdinal, ...(requestId ? [requestId] : [])) as SqlRow[];
    return rows.map((row) => ({
      id: String(row.id),
      ordinal: Number(row.ordinal),
      requestId: String(row.request_id),
      sequence: Number(row.sequence),
      storageKey: String(row.storage_key),
      checksum: String(row.checksum),
      rowCount: Number(row.row_count),
    }));
  }

  async clearCrawlSession(runId: string): Promise<void> {
    this.sqlite.prepare('DELETE FROM collection_crawl_sessions WHERE run_id=?').run(runId);
  }

  async requestCrawlCleanup(
    runId: string,
    taskId: string,
    reason: CrawlCleanupIntent['reason'],
  ): Promise<void> {
    if (!['canceled', 'deleted', 'terminal'].includes(reason))
      throw new Error('VALIDATION: Invalid cleanup reason');
    const run = this.sqlite.prepare('SELECT task_id FROM runs WHERE id=?').get(runId) as
      SqlRow | undefined;
    const intent = this.sqlite
      .prepare('SELECT task_id FROM collection_crawl_cleanup WHERE run_id=?')
      .get(runId) as SqlRow | undefined;
    if ((run && run.task_id !== taskId) || (intent && intent.task_id !== taskId))
      throw new Error('VALIDATION: Cleanup owner mismatch');
    const at = now();
    this.sqlite
      .prepare(
        "INSERT INTO collection_crawl_cleanup(run_id,task_id,reason,created_at,available_at) VALUES (?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET reason=CASE WHEN collection_crawl_cleanup.reason='deleted' THEN 'deleted' WHEN collection_crawl_cleanup.reason='canceled' THEN 'canceled' ELSE excluded.reason END",
      )
      .run(runId, taskId, reason, at, at);
  }

  async getCrawlCleanup(runId: string): Promise<CrawlCleanupIntent | null> {
    const row = this.sqlite
      .prepare('SELECT * FROM collection_crawl_cleanup WHERE run_id=?')
      .get(runId) as SqlRow | undefined;
    return row ? crawlCleanupRow(row) : null;
  }

  async listCrawlCleanup(afterRunId = '', dueAt = now()): Promise<CrawlCleanupIntent[]> {
    return (
      this.sqlite
        .prepare(
          'SELECT * FROM collection_crawl_cleanup WHERE run_id>? AND available_at<=? ORDER BY run_id LIMIT 100',
        )
        .all(afterRunId, dueAt) as SqlRow[]
    ).map(crawlCleanupRow);
  }

  async retryCrawlCleanup(runId: string): Promise<void> {
    const row = this.sqlite
      .prepare('SELECT attempts FROM collection_crawl_cleanup WHERE run_id=?')
      .get(runId) as SqlRow | undefined;
    if (!row) return;
    const attempts = Number(row.attempts) + 1;
    this.sqlite
      .prepare(
        "UPDATE collection_crawl_cleanup SET attempts=?,available_at=?,error_code='COLLECTION_CLEANUP_FAILED' WHERE run_id=?",
      )
      .run(
        attempts,
        new Date(
          Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(attempts - 1, 6)),
        ).toISOString(),
        runId,
      );
  }

  async acknowledgeCrawlCleanup(runId: string): Promise<void> {
    this.sqlite.prepare('DELETE FROM collection_crawl_cleanup WHERE run_id=?').run(runId);
  }

  async listCrawlSessionOwners(afterRunId = '') {
    return (
      this.sqlite
        .prepare(
          'SELECT s.run_id,s.fingerprint,r.task_id FROM collection_crawl_sessions s JOIN runs r ON r.id=s.run_id WHERE s.run_id>? ORDER BY s.run_id LIMIT 100',
        )
        .all(afterRunId) as SqlRow[]
    ).map((row) => ({
      runId: String(row.run_id),
      taskId: String(row.task_id),
      fingerprint: String(row.fingerprint),
    }));
  }

  async listCrawlRequests(
    runId: string,
    fingerprint: string,
    stage?: CrawlRequestStage,
    afterOrdinal = 0,
  ): Promise<CrawlRequestCheckpoint[]> {
    this.assertCrawlFingerprint(runId, fingerprint);
    return (
      this.sqlite
        .prepare(
          `SELECT * FROM collection_crawl_requests WHERE run_id=? AND ordinal>? ${stage ? 'AND stage=?' : ''} ORDER BY ordinal LIMIT 100`,
        )
        .all(runId, afterOrdinal, ...(stage ? [stage] : [])) as SqlRow[]
    ).map(crawlRequestRow);
  }

  async ensureCrawlRequest(
    runId: string,
    fingerprint: string,
    seed: CrawlRequestSeed,
    maxRequests: number,
  ): Promise<CrawlRequestCheckpoint | null> {
    assertCrawlSeed(seed);
    assertCrawlLimit(maxRequests, 10_000);
    return this.sqlite.transaction(() => {
      this.assertCrawlFingerprint(runId, fingerprint);
      return this.ensureCrawlRequestInTransaction(runId, seed, maxRequests);
    })();
  }

  private ensureCrawlRequestInTransaction(
    runId: string,
    seed: CrawlRequestSeed,
    maxRequests: number,
  ): CrawlRequestCheckpoint | null {
    const previous = this.sqlite
      .prepare('SELECT * FROM collection_crawl_requests WHERE run_id=? AND id=?')
      .get(runId, seed.id) as SqlRow | undefined;
    if (previous) {
      if (previous.url !== seed.url || previous.stage !== seed.stage)
        throw new Error('VALIDATION: Request identity changed during recovery');
      return crawlRequestRow(previous);
    }
    const session = this.sqlite
      .prepare('SELECT request_count FROM collection_crawl_sessions WHERE run_id=?')
      .get(runId) as SqlRow;
    const count = Number(session.request_count);
    if (count >= maxRequests) return null;
    this.sqlite
      .prepare(
        "INSERT INTO collection_crawl_requests(run_id,id,ordinal,url,stage,kind,status) VALUES (?,?,?,?,?,?,'pending')",
      )
      .run(runId, seed.id, count + 1, seed.url, seed.stage, seed.kind);
    this.sqlite
      .prepare('UPDATE collection_crawl_sessions SET request_count=request_count+1 WHERE run_id=?')
      .run(runId);
    return crawlRequestRow(
      this.sqlite
        .prepare('SELECT * FROM collection_crawl_requests WHERE run_id=? AND id=?')
        .get(runId, seed.id) as SqlRow,
    );
  }

  async reserveCrawlRecords(
    runId: string,
    fingerprint: string,
    requestId: string,
    available: number,
    maxRecords: number,
  ): Promise<number> {
    assertCrawlLimit(maxRecords, 10_000_000);
    if (!Number.isSafeInteger(available) || available < 0)
      throw new Error('VALIDATION: Invalid request record capacity');
    return this.sqlite.transaction(() => {
      this.assertCrawlFingerprint(runId, fingerprint);
      const row = this.sqlite
        .prepare('SELECT * FROM collection_crawl_requests WHERE run_id=? AND id=?')
        .get(runId, requestId) as SqlRow | undefined;
      if (!row || row.stage === 'detail')
        throw new Error('VALIDATION: Request cannot reserve list records');
      if (row.reserved_records !== null) {
        if (Number(row.reserved_records) > available)
          throw new Error('VALIDATION: Replayed page contains fewer reserved records');
        return Number(row.reserved_records);
      }
      const session = this.sqlite
        .prepare('SELECT raw_record_count FROM collection_crawl_sessions WHERE run_id=?')
        .get(runId) as SqlRow;
      const count = Math.min(available, Math.max(0, maxRecords - Number(session.raw_record_count)));
      this.sqlite
        .prepare('UPDATE collection_crawl_requests SET reserved_records=? WHERE run_id=? AND id=?')
        .run(count, runId, requestId);
      this.sqlite
        .prepare(
          'UPDATE collection_crawl_sessions SET raw_record_count=raw_record_count+? WHERE run_id=?',
        )
        .run(count, runId);
      return count;
    })();
  }

  async beginBrowserRound(
    runId: string,
    fingerprint: string,
    input: Parameters<CrawlBrowserPagination['begin']>[0],
  ): Promise<CrawlBrowserRound> {
    assertBrowserRound(input.requestId, input.round);
    assertCrawlUrl(input.sourceUrl);
    assertCrawlLimit(input.maxRecords, 10_000_000);
    if (
      !/^[a-f0-9]{64}$/.test(input.checksum) ||
      input.recordHashes.length > 10_000_000 ||
      input.recordHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))
    )
      throw new Error('VALIDATION: Invalid browser observation');
    return this.sqlite.transaction(() => {
      this.assertCrawlFingerprint(runId, fingerprint);
      const request = this.sqlite
        .prepare('SELECT * FROM collection_crawl_requests WHERE run_id=? AND id=?')
        .get(runId, input.requestId) as SqlRow | undefined;
      if (!request || request.stage !== 'browser')
        throw new Error('VALIDATION: Browser request checkpoint is unavailable');
      const previous = this.sqlite
        .prepare(
          'SELECT * FROM collection_crawl_browser_rounds WHERE run_id=? AND request_id=? AND round=?',
        )
        .get(runId, input.requestId, input.round) as SqlRow | undefined;
      if (previous) {
        if (
          previous.checksum !== input.checksum ||
          previous.source_url !== input.sourceUrl ||
          Number(previous.observed_records) !== input.recordHashes.length
        )
          throw new ZhiYunError(
            'VALIDATION_ERROR',
            'VALIDATION: Browser replay data changed; start a new run',
          );
        return browserRoundRow(previous);
      }
      const last = this.sqlite
        .prepare(
          'SELECT * FROM collection_crawl_browser_rounds WHERE run_id=? AND request_id=? ORDER BY round DESC LIMIT 1',
        )
        .get(runId, input.requestId) as SqlRow | undefined;
      if (
        request.status !== 'pending' ||
        (last
          ? last.status !== 'completed' ||
            input.round !== Number(last.round) + 1 ||
            browserRoundRow(last).state?.terminal
          : input.round !== 0 || request.reserved_records !== null)
      )
        throw new Error('VALIDATION: Browser rounds must be confirmed in order');
      const session = this.sqlite
        .prepare('SELECT raw_record_count FROM collection_crawl_sessions WHERE run_id=?')
        .get(runId) as SqlRow;
      const capacity = Math.max(0, input.maxRecords - Number(session.raw_record_count));
      this.sqlite
        .prepare(
          "INSERT INTO collection_crawl_browser_rounds(run_id,request_id,round,source_url,checksum,observed_records,available_records,reserved_records,status) VALUES (?,?,?,?,?,?,0,0,'pending')",
        )
        .run(
          runId,
          input.requestId,
          input.round,
          input.sourceUrl,
          input.checksum,
          input.recordHashes.length,
        );
      const findSeen = this.sqlite.prepare(
        'SELECT occurrence_count FROM collection_crawl_browser_seen WHERE run_id=? AND request_id=? AND record_hash=?',
      );
      const select = this.sqlite.prepare(
        'INSERT INTO collection_crawl_browser_selected(run_id,request_id,round,position) VALUES (?,?,?,?)',
      );
      const observe = this.sqlite.prepare(
        'INSERT INTO collection_crawl_browser_observed(run_id,request_id,round,record_hash,occurrence_count) VALUES (?,?,?,?,?)',
      );
      // Only hashes/counts for this bounded response are held in memory. Seen
      // multiplicity across rounds is on disk, so equal rows in one list survive.
      const counts = new Map<string, { seen: number; current: number }>();
      let available = 0;
      let reserved = 0;
      for (const [position, hash] of input.recordHashes.entries()) {
        let count = counts.get(hash);
        if (!count) {
          const seen = findSeen.get(runId, input.requestId, hash) as SqlRow | undefined;
          count = { seen: Number(seen?.occurrence_count ?? 0), current: 0 };
          counts.set(hash, count);
        }
        count.current++;
        if (count.current > count.seen) {
          available++;
          if (reserved < capacity) {
            select.run(runId, input.requestId, input.round, position);
            reserved++;
          }
        }
      }
      for (const [hash, count] of counts)
        observe.run(runId, input.requestId, input.round, hash, count.current);
      this.sqlite
        .prepare(
          'UPDATE collection_crawl_browser_rounds SET available_records=?,reserved_records=? WHERE run_id=? AND request_id=? AND round=?',
        )
        .run(available, reserved, runId, input.requestId, input.round);
      this.sqlite
        .prepare(
          'UPDATE collection_crawl_requests SET reserved_records=COALESCE(reserved_records,0)+? WHERE run_id=? AND id=?',
        )
        .run(reserved, runId, input.requestId);
      this.sqlite
        .prepare(
          'UPDATE collection_crawl_sessions SET raw_record_count=raw_record_count+? WHERE run_id=?',
        )
        .run(reserved, runId);
      return {
        status: 'pending' as const,
        reservedRecords: reserved,
        availableRecords: available,
        state: null,
      };
    })();
  }

  async listBrowserSelected(
    runId: string,
    fingerprint: string,
    requestId: string,
    round: number,
    afterPosition = -1,
  ): Promise<number[]> {
    this.assertCrawlFingerprint(runId, fingerprint);
    assertBrowserRound(requestId, round);
    if (!Number.isSafeInteger(afterPosition) || afterPosition < -1)
      throw new Error('VALIDATION: Invalid browser selection cursor');
    return (
      this.sqlite
        .prepare(
          'SELECT position FROM collection_crawl_browser_selected WHERE run_id=? AND request_id=? AND round=? AND position>? ORDER BY position LIMIT 250',
        )
        .all(runId, requestId, round, afterPosition) as SqlRow[]
    ).map((row) => Number(row.position));
  }

  async completeBrowserRound(
    runId: string,
    fingerprint: string,
    requestId: string,
    round: number,
    state: Parameters<CrawlBrowserPagination['complete']>[2],
  ): Promise<void> {
    assertBrowserRound(requestId, round);
    state = checkedBrowserState(state);
    this.sqlite.transaction(() => {
      this.assertCrawlFingerprint(runId, fingerprint);
      const current = this.sqlite
        .prepare(
          'SELECT * FROM collection_crawl_browser_rounds WHERE run_id=? AND request_id=? AND round=?',
        )
        .get(runId, requestId, round) as SqlRow | undefined;
      if (!current) throw new Error('VALIDATION: Browser round is unavailable');
      if (current.status === 'completed') {
        if (current.state_json !== json(state))
          throw new Error('VALIDATION: Replayed browser completion changed');
        return;
      }
      const base = round * BROWSER_ROUND_BATCH_STRIDE;
      const stored = this.sqlite
        .prepare(
          'SELECT COALESCE(SUM(row_count),0) AS total,COUNT(*) AS batches,MIN(sequence) AS first,MAX(sequence) AS last FROM collection_crawl_batches WHERE run_id=? AND request_id=? AND sequence>=? AND sequence<?',
        )
        .get(runId, requestId, base, base + BROWSER_ROUND_BATCH_STRIDE) as SqlRow;
      if (
        Number(stored.total) !== Number(current.reserved_records) ||
        Number(stored.batches) !== state.batchCount ||
        (state.batchCount > 0 &&
          (Number(stored.first) !== base || Number(stored.last) !== base + state.batchCount - 1))
      )
        throw new Error('VALIDATION: Browser round batches are not durably complete');
      this.sqlite
        .prepare(
          'INSERT INTO collection_crawl_browser_seen(run_id,request_id,record_hash,occurrence_count) SELECT run_id,request_id,record_hash,occurrence_count FROM collection_crawl_browser_observed WHERE run_id=? AND request_id=? AND round=? ON CONFLICT(run_id,request_id,record_hash) DO UPDATE SET occurrence_count=MAX(occurrence_count,excluded.occurrence_count)',
        )
        .run(runId, requestId, round);
      this.sqlite
        .prepare(
          "UPDATE collection_crawl_browser_rounds SET status='completed',state_json=? WHERE run_id=? AND request_id=? AND round=?",
        )
        .run(json(state), runId, requestId, round);
      this.sqlite
        .prepare(
          'DELETE FROM collection_crawl_browser_selected WHERE run_id=? AND request_id=? AND round=?',
        )
        .run(runId, requestId, round);
      this.sqlite
        .prepare(
          'DELETE FROM collection_crawl_browser_observed WHERE run_id=? AND request_id=? AND round=?',
        )
        .run(runId, requestId, round);
    })();
  }

  async completeCrawlRequest(
    runId: string,
    fingerprint: string,
    requestId: string,
    result: Parameters<CrawlCheckpoint['complete']>[1],
    maxRequests: number,
  ): Promise<CrawlRequestCheckpoint> {
    assertCrawlLimit(maxRequests, 10_000);
    assertCrawlUrl(result.sourceUrl);
    if (typeof result.browserUsed !== 'boolean' || result.nextRequests.length > 1)
      throw new Error('VALIDATION: Invalid request checkpoint');
    const nextRequests = result.nextRequests.map((seed) => {
      assertCrawlSeed(seed);
      return { id: seed.id, url: seed.url, stage: seed.stage, kind: seed.kind };
    });
    const nextJson = json(nextRequests);
    return this.sqlite.transaction(() => {
      this.assertCrawlFingerprint(runId, fingerprint);
      const row = this.sqlite
        .prepare('SELECT * FROM collection_crawl_requests WHERE run_id=? AND id=?')
        .get(runId, requestId) as SqlRow | undefined;
      if (!row) throw new Error('VALIDATION: Request checkpoint is unavailable');
      const browserRound = this.sqlite
        .prepare(
          'SELECT * FROM collection_crawl_browser_rounds WHERE run_id=? AND request_id=? ORDER BY round DESC LIMIT 1',
        )
        .get(runId, requestId) as SqlRow | undefined;
      if (
        browserRound &&
        (browserRound.status !== 'completed' || !browserRoundRow(browserRound).state?.terminal)
      )
        throw new Error('VALIDATION: Browser pagination is not durably complete');
      const sitemapNode = this.sqlite
        .prepare('SELECT 1 FROM collection_crawl_sitemap_nodes WHERE run_id=? AND id=?')
        .get(runId, requestId);
      if (sitemapNode) {
        const stored = this.sqlite
          .prepare(
            'SELECT COUNT(*) AS total,MIN(sequence) AS first,MAX(sequence) AS last FROM collection_crawl_sitemap_batches WHERE run_id=? AND request_id=?',
          )
          .get(runId, requestId) as SqlRow;
        const count = result.discoveryBatchCount;
        if (
          count === undefined ||
          !Number.isSafeInteger(count) ||
          count < 0 ||
          Number(stored.total) !== count ||
          (count > 0 && (Number(stored.first) !== 0 || Number(stored.last) !== count - 1))
        )
          throw new Error('VALIDATION: Sitemap batches are not durably complete');
      } else if (result.discoveryBatchCount !== undefined)
        throw new Error('VALIDATION: Unexpected discovery completion');
      if (nextRequests.some((seed) => seed.stage !== row.stage || seed.kind !== 'pagination'))
        throw new Error('VALIDATION: Invalid pagination successor');
      if (row.stage !== 'detail') {
        const stored = this.sqlite
          .prepare(
            'SELECT COALESCE(SUM(row_count),0) AS total FROM collection_crawl_batches WHERE run_id=? AND request_id=?',
          )
          .get(runId, requestId) as SqlRow;
        if (row.reserved_records === null || Number(stored.total) !== Number(row.reserved_records))
          throw new Error('VALIDATION: Request batches are not durably complete');
      }
      if (row.status === 'completed') {
        if (
          row.source_url !== result.sourceUrl ||
          Boolean(row.browser_used) !== result.browserUsed ||
          row.next_requests !== nextJson
        )
          throw new Error('VALIDATION: Replayed request checkpoint changed');
      } else {
        this.sqlite
          .prepare(
            "UPDATE collection_crawl_requests SET status='completed',source_url=?,browser_used=?,next_requests=? WHERE run_id=? AND id=?",
          )
          .run(result.sourceUrl, result.browserUsed ? 1 : 0, nextJson, runId, requestId);
      }
      // Parent completion and any affordable successor are in the same transaction.
      for (const seed of nextRequests)
        this.ensureCrawlRequestInTransaction(runId, seed, maxRequests);
      return crawlRequestRow(
        this.sqlite
          .prepare('SELECT * FROM collection_crawl_requests WHERE run_id=? AND id=?')
          .get(runId, requestId) as SqlRow,
      );
    })();
  }

  async getCrawlSummary(
    runId: string,
    fingerprint: string,
  ): ReturnType<CrawlCheckpoint['summary']> {
    this.assertCrawlFingerprint(runId, fingerprint);
    const row = this.sqlite
      .prepare(
        'SELECT request_count,raw_record_count,EXISTS(SELECT 1 FROM collection_crawl_requests WHERE run_id=? AND browser_used=1) AS browser_used FROM collection_crawl_sessions WHERE run_id=?',
      )
      .get(runId, runId) as SqlRow;
    return {
      requestCount: Number(row.request_count),
      rawRecordCount: Number(row.raw_record_count),
      browserUsed: Boolean(row.browser_used),
    };
  }

  async getCrawlResult(runId: string, fingerprint: string): Promise<SavedCrawlResult | null> {
    const row = this.sqlite
      .prepare('SELECT fingerprint,result_json FROM collection_crawl_sessions WHERE run_id=?')
      .get(runId) as SqlRow | undefined;
    if (!row) return null;
    if (row.fingerprint !== fingerprint)
      throw new Error('VALIDATION: Crawl fingerprint changed; start a new run');
    if (row.result_json === null) return null;
    return checkedCrawlResult(JSON.parse(String(row.result_json)) as SavedCrawlResult);
  }

  async saveCrawlResult(
    runId: string,
    fingerprint: string,
    result: SavedCrawlResult,
  ): Promise<void> {
    const payload = json(checkedCrawlResult(result));
    this.sqlite.transaction(() => {
      this.assertCrawlFingerprint(runId, fingerprint);
      const row = this.sqlite
        .prepare('SELECT result_json FROM collection_crawl_sessions WHERE run_id=?')
        .get(runId) as SqlRow;
      if (row.result_json !== null && row.result_json !== payload)
        throw new Error('VALIDATION: Completed crawl result changed during recovery');
      this.sqlite
        .prepare('UPDATE collection_crawl_sessions SET result_json=? WHERE run_id=?')
        .run(payload, runId);
    })();
  }

  async enqueueSitemapRoot(
    runId: string,
    fingerprint: string,
    node: Omit<CrawlSitemapNode, 'ordinal'>,
    maxSitemaps: number,
  ): Promise<void> {
    assertSitemapNode(node);
    if (node.depth !== 0) throw new Error('VALIDATION: Sitemap root depth must be zero');
    assertCrawlLimit(maxSitemaps, 100);
    this.sqlite.transaction(() => {
      this.assertCrawlFingerprint(runId, fingerprint);
      this.enqueueSitemapNode(runId, node, maxSitemaps);
    })();
  }

  private enqueueSitemapNode(
    runId: string,
    node: Omit<CrawlSitemapNode, 'ordinal'>,
    maximum: number,
  ): void {
    if (
      this.sqlite
        .prepare('SELECT 1 FROM collection_crawl_sitemap_nodes WHERE run_id=? AND id=?')
        .get(runId, node.id)
    )
      return;
    const row = this.sqlite
      .prepare('SELECT sitemap_node_count FROM collection_crawl_sessions WHERE run_id=?')
      .get(runId) as SqlRow;
    const count = Number(row.sitemap_node_count);
    if (count >= maximum) {
      this.sqlite
        .prepare('UPDATE collection_crawl_sessions SET sitemap_truncated=1 WHERE run_id=?')
        .run(runId);
      return;
    }
    this.sqlite
      .prepare(
        'INSERT INTO collection_crawl_sitemap_nodes(run_id,id,ordinal,url,depth) VALUES (?,?,?,?,?)',
      )
      .run(runId, node.id, count + 1, node.url, node.depth);
    this.sqlite
      .prepare(
        'UPDATE collection_crawl_sessions SET sitemap_node_count=sitemap_node_count+1 WHERE run_id=?',
      )
      .run(runId);
  }

  async listSitemapNodes(
    runId: string,
    fingerprint: string,
    afterOrdinal = 0,
  ): Promise<CrawlSitemapNode[]> {
    this.assertCrawlFingerprint(runId, fingerprint);
    return (
      this.sqlite
        .prepare(
          'SELECT * FROM collection_crawl_sitemap_nodes WHERE run_id=? AND ordinal>? ORDER BY ordinal LIMIT 100',
        )
        .all(runId, afterOrdinal) as SqlRow[]
    ).map((row) => ({
      id: String(row.id),
      url: String(row.url),
      depth: Number(row.depth),
      ordinal: Number(row.ordinal),
    }));
  }

  async stageSitemapBatch(
    runId: string,
    fingerprint: string,
    input: Parameters<CollectionRepository['stageSitemapBatch']>[2],
  ): Promise<void> {
    const { batch, id, checksum, storageKey, maxSitemaps, maxUrls } = input;
    assertCrawlLimit(maxSitemaps, 100);
    assertCrawlLimit(maxUrls, 10_000);
    if (
      !/^[a-f0-9]{64}$/.test(batch.requestId) ||
      checksum !== sha256(json(batch)) ||
      !Number.isSafeInteger(batch.sequence) ||
      batch.sequence < 0 ||
      batch.entries.length + batch.nodes.length > 250 ||
      id !== sha256(`${fingerprint}/discovery/${batch.requestId}/${batch.sequence}`) ||
      storageKey !== `collection-batches/${runId}/discovery/${id}.json`
    )
      throw new Error('VALIDATION: Invalid sitemap batch');
    for (const node of batch.nodes) assertSitemapNode(node);
    for (const entry of batch.entries) {
      assertCrawlUrl(entry.url);
      if (
        entry.lastModified !== null &&
        (!Number.isFinite(Date.parse(entry.lastModified)) ||
          entry.lastModified !== new Date(entry.lastModified).toISOString())
      )
        throw new Error('VALIDATION: Invalid sitemap modification time');
    }
    this.sqlite.transaction(() => {
      this.assertCrawlFingerprint(runId, fingerprint);
      const previous = this.sqlite
        .prepare('SELECT * FROM collection_crawl_sitemap_batches WHERE run_id=? AND id=?')
        .get(runId, id) as SqlRow | undefined;
      if (previous) {
        if (
          previous.checksum !== checksum ||
          previous.storage_key !== storageKey ||
          previous.request_id !== batch.requestId ||
          previous.sequence !== batch.sequence
        )
          throw new Error('VALIDATION: Replayed sitemap batch changed');
        return;
      }
      const request = this.sqlite
        .prepare('SELECT * FROM collection_crawl_requests WHERE run_id=? AND id=?')
        .get(runId, batch.requestId) as SqlRow | undefined;
      const node = this.sqlite
        .prepare('SELECT * FROM collection_crawl_sitemap_nodes WHERE run_id=? AND id=?')
        .get(runId, batch.requestId) as SqlRow | undefined;
      if (
        !request ||
        request.stage !== 'api' ||
        request.status !== 'pending' ||
        !node ||
        batch.nodes.some((child) => child.depth !== Number(node.depth) + 1)
      )
        throw new Error('VALIDATION: Sitemap batch has no pending discovery request');
      for (const child of batch.nodes) this.enqueueSitemapNode(runId, child, maxSitemaps);
      const state = this.sqlite
        .prepare('SELECT sitemap_entry_count FROM collection_crawl_sessions WHERE run_id=?')
        .get(runId) as SqlRow;
      let count = Number(state.sitemap_entry_count);
      for (const entry of batch.entries) {
        if (count >= maxUrls) break;
        const inserted = this.sqlite
          .prepare(
            'INSERT OR IGNORE INTO collection_crawl_sitemap_entries(run_id,url,ordinal,last_modified,modified) VALUES (?,?,?,?,?)',
          )
          .run(
            runId,
            entry.url,
            count + 1,
            entry.lastModified,
            entry.lastModified === null ? 0 : Date.parse(entry.lastModified),
          );
        count += inserted.changes;
      }
      this.sqlite
        .prepare('UPDATE collection_crawl_sessions SET sitemap_entry_count=? WHERE run_id=?')
        .run(count, runId);
      this.sqlite
        .prepare(
          'INSERT INTO collection_crawl_sitemap_batches(run_id,id,ordinal,request_id,sequence,checksum,storage_key,row_count) VALUES (?,?,(SELECT COALESCE(MAX(ordinal),0)+1 FROM collection_crawl_sitemap_batches WHERE run_id=?),?,?,?,?,?)',
        )
        .run(
          runId,
          id,
          runId,
          batch.requestId,
          batch.sequence,
          checksum,
          storageKey,
          batch.entries.length + batch.nodes.length,
        );
    })();
  }

  async getSitemapState(runId: string, fingerprint: string) {
    this.assertCrawlFingerprint(runId, fingerprint);
    const row = this.sqlite
      .prepare(
        'SELECT sitemap_node_count,sitemap_entry_count,sitemap_truncated FROM collection_crawl_sessions WHERE run_id=?',
      )
      .get(runId) as SqlRow;
    return {
      nodeCount: Number(row.sitemap_node_count),
      entryCount: Number(row.sitemap_entry_count),
      sitemapsTruncated: Boolean(row.sitemap_truncated),
    };
  }

  async listSitemapBatches(
    runId: string,
    fingerprint: string,
    afterOrdinal = 0,
  ): Promise<StoredCrawlBatch[]> {
    this.assertCrawlFingerprint(runId, fingerprint);
    return (
      this.sqlite
        .prepare(
          'SELECT * FROM collection_crawl_sitemap_batches WHERE run_id=? AND ordinal>? ORDER BY ordinal LIMIT 100',
        )
        .all(runId, afterOrdinal) as SqlRow[]
    ).map((row) => ({
      id: String(row.id),
      ordinal: Number(row.ordinal),
      requestId: String(row.request_id),
      sequence: Number(row.sequence),
      checksum: String(row.checksum),
      storageKey: String(row.storage_key),
      rowCount: Number(row.row_count),
    }));
  }

  async listSitemapEntries(
    runId: string,
    fingerprint: string,
    sorted: boolean,
    cursor?: { ordinal: number; modified: number },
  ) {
    this.assertCrawlFingerprint(runId, fingerprint);
    const condition = cursor
      ? sorted
        ? 'AND (modified<? OR (modified=? AND ordinal>?))'
        : 'AND ordinal>?'
      : '';
    const args = cursor
      ? sorted
        ? [cursor.modified, cursor.modified, cursor.ordinal]
        : [cursor.ordinal]
      : [];
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM collection_crawl_sitemap_entries WHERE run_id=? ${condition} ORDER BY ${sorted ? 'modified DESC,' : ''}ordinal LIMIT 250`,
      )
      .all(runId, ...args) as SqlRow[];
    return rows.map((row) => ({
      url: String(row.url),
      lastModified: nullableString(row.last_modified),
      modified: Number(row.modified),
      ordinal: Number(row.ordinal),
    }));
  }

  private assertCrawlFingerprint(runId: string, fingerprint: string): void {
    const row = this.sqlite
      .prepare('SELECT fingerprint FROM collection_crawl_sessions WHERE run_id=?')
      .get(runId) as SqlRow | undefined;
    if (!row || row.fingerprint !== fingerprint)
      throw new Error('VALIDATION: Crawl session does not match this run');
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
            ...(existing ? (JSON.parse(String(existing.metadata)) as Record<string, unknown>) : {}),
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
    retryPending = false,
  ): Promise<CrawlRun | null> {
    return this.sqlite.transaction(() => {
      const timestamp = now();
      const result = this.sqlite
        .prepare(
          `UPDATE runs SET
             status=?,finished_at=?,error=?,error_code=?,phase=?,progress=CASE WHEN ? THEN progress ELSE 1 END
           WHERE id=? AND task_id=? AND status IN ('queued','running')`,
        )
        .run(
          retryPending ? 'queued' : 'failed',
          retryPending ? null : timestamp,
          error,
          code,
          retryPending ? 'retrying' : 'failed',
          retryPending ? 1 : 0,
          runId,
          taskId,
        );
      if (result.changes !== 1) return null;
      this.sqlite
        .prepare('UPDATE tasks SET status=?,updated_at=? WHERE id=?')
        .run(retryPending ? 'ready' : 'failed', timestamp, taskId);
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
      if (!row || !['queued', 'running', 'canceled'].includes(String(row.status))) return null;
      const timestamp = now();
      this.sqlite
        .prepare(
          "INSERT INTO collection_crawl_cleanup(run_id,task_id,reason,created_at,available_at) VALUES (?,?,'canceled',?,?) ON CONFLICT(run_id) DO NOTHING",
        )
        .run(runId, row.task_id, timestamp, timestamp);
      if (row.status === 'canceled') return runRow(row);
      if (row.status === 'queued') return cancelRunSync(this.sqlite, row);
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
      let metadata = entry.metadata;
      if (entry.phase === 'diagnostic') {
        const previous = this.sqlite
          .prepare(
            "SELECT json_extract(metadata,'$.diagnosticTotal') AS total FROM run_logs WHERE run_id=? AND phase='diagnostic' ORDER BY sequence DESC LIMIT 1",
          )
          .get(entry.runId) as SqlRow | undefined;
        metadata = { ...metadata, diagnosticTotal: Number(previous?.total ?? 0) + 1 };
      }
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
          json(metadata),
          timestamp,
        );
      const progress = entry.metadata.progress;
      if (entry.phase !== 'diagnostic') {
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
      }
      if (entry.phase === 'diagnostic')
        this.sqlite
          .prepare(
            "DELETE FROM run_logs WHERE run_id=? AND phase='diagnostic' AND id NOT IN (SELECT id FROM run_logs WHERE run_id=? AND phase='diagnostic' ORDER BY sequence DESC LIMIT 256)",
          )
          .run(entry.runId, entry.runId);
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

  async getRunDiagnosticLogs(runId: string): Promise<{ items: RunLogEntry[]; stepCount: number }> {
    const count = this.sqlite
      .prepare(
        "SELECT MAX(json_extract(metadata,'$.diagnosticTotal')) AS count FROM run_logs WHERE run_id=? AND phase='diagnostic'",
      )
      .get(runId) as SqlRow;
    const items = (
      this.sqlite
        .prepare(
          "SELECT * FROM run_logs WHERE run_id=? AND phase='diagnostic' ORDER BY sequence DESC LIMIT 256",
        )
        .all(runId) as SqlRow[]
    )
      .reverse()
      .map(runLogRow);
    return { items, stepCount: Number(count.count) };
  }

  async clearRunDiagnostics(runId: string): Promise<number> {
    return this.sqlite
      .prepare("DELETE FROM run_logs WHERE run_id=? AND phase='diagnostic'")
      .run(runId).changes;
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

  async markRuleRepairProposalTested(
    id: string,
    tested = true,
  ): Promise<RuleRepairProposal | null> {
    const result = this.sqlite
      .prepare("UPDATE rule_repair_proposals SET tested_at=? WHERE id=? AND status='pending'")
      .run(tested ? now() : null, id);
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
  if (schedule.mode !== 'cron' || !schedule.cron || schedule.paused) {
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

function assertCrawlLimit(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error('VALIDATION: Invalid crawl checkpoint limit');
}

function assertCrawlUrl(value: string): void {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('VALIDATION: Request checkpoints require HTTP URLs without credentials');
}

function assertCrawlSeed(seed: CrawlRequestSeed): void {
  assertCrawlUrl(seed.url);
  if (
    !['api', 'http', 'browser', 'detail'].includes(seed.stage) ||
    !['list', 'pagination', 'api', 'detail'].includes(seed.kind) ||
    (seed.stage === 'detail') !== (seed.kind === 'detail') ||
    seed.id !== sha256(JSON.stringify({ requestedUrl: seed.url, stage: seed.stage }))
  )
    throw new Error('VALIDATION: Invalid request checkpoint identity');
}

function assertBrowserRound(requestId: string, round: number): void {
  if (!/^[a-f0-9]{64}$/.test(requestId) || !Number.isSafeInteger(round) || round < 0 || round > 100)
    throw new Error('VALIDATION: Invalid browser round identity');
}

function checkedBrowserState(
  state: Parameters<CrawlBrowserPagination['complete']>[2],
): Parameters<CrawlBrowserPagination['complete']>[2] {
  if (
    typeof state.terminal !== 'boolean' ||
    !Number.isSafeInteger(state.height) ||
    state.height < 0 ||
    !/^[a-f0-9]{64}$/.test(state.domHash) ||
    !Number.isSafeInteger(state.stableRounds) ||
    state.stableRounds < 0 ||
    state.stableRounds > 2 ||
    !Number.isSafeInteger(state.batchCount) ||
    state.batchCount < 0 ||
    state.batchCount >= BROWSER_ROUND_BATCH_STRIDE
  )
    throw new Error('VALIDATION: Invalid browser round state');
  // Persist only the typed cursor fields, in a stable order. Runtime callers
  // cannot smuggle page content into state_json through additional properties.
  return {
    terminal: state.terminal,
    height: state.height,
    domHash: state.domHash,
    stableRounds: state.stableRounds,
    batchCount: state.batchCount,
  };
}

function browserRoundRow(row: SqlRow): CrawlBrowserRound {
  const state =
    row.state_json === null ? null : checkedBrowserState(JSON.parse(String(row.state_json)));
  if (row.status === 'completed' && !state)
    throw new Error('VALIDATION: Completed browser round has no state');
  return {
    status: row.status as CrawlBrowserRound['status'],
    reservedRecords: Number(row.reserved_records),
    availableRecords: Number(row.available_records),
    state,
  };
}

function assertSitemapNode(node: Omit<CrawlSitemapNode, 'ordinal'>): void {
  assertCrawlSeed({ id: node.id, url: node.url, stage: 'api', kind: 'api' });
  if (!Number.isSafeInteger(node.depth) || node.depth < 0 || node.depth > 3)
    throw new Error('VALIDATION: Invalid sitemap depth');
}

function crawlCleanupRow(row: SqlRow): CrawlCleanupIntent {
  return {
    runId: String(row.run_id),
    taskId: String(row.task_id),
    reason: row.reason as CrawlCleanupIntent['reason'],
    availableAt: String(row.available_at),
    attempts: Number(row.attempts),
    errorCode: nullableString(row.error_code),
  };
}

function crawlRequestRow(row: SqlRow): CrawlRequestCheckpoint {
  return {
    id: String(row.id),
    url: String(row.url),
    stage: row.stage as CrawlRequestStage,
    kind: row.kind as CrawlRequestSeed['kind'],
    ordinal: Number(row.ordinal),
    status: row.status as CrawlRequestCheckpoint['status'],
    reservedRecords: row.reserved_records === null ? null : Number(row.reserved_records),
    sourceUrl: nullableString(row.source_url),
    browserUsed: Boolean(row.browser_used),
    nextRequests: JSON.parse(String(row.next_requests)) as CrawlRequestSeed[],
  };
}

function checkedCrawlResult(value: SavedCrawlResult): SavedCrawlResult {
  const actionCache =
    value.actionCache === undefined
      ? undefined
      : browserActionCacheSummarySchema.safeParse(value.actionCache);
  if (actionCache && !actionCache.success)
    throw new Error('VALIDATION: Invalid durable action cache summary');
  if (
    !Number.isSafeInteger(value.recordCount) ||
    value.recordCount < 0 ||
    value.recordCount > 10_000_000 ||
    !Number.isSafeInteger(value.requestCount) ||
    value.requestCount < 0 ||
    value.requestCount > 10_000 ||
    typeof value.browserUsed !== 'boolean' ||
    typeof value.aiUsed !== 'boolean' ||
    (value.durationMs !== null && (!Number.isFinite(value.durationMs) || value.durationMs < 0)) ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every((item) => typeof item === 'string') ||
    (value.warningTotal !== undefined &&
      (!Number.isSafeInteger(value.warningTotal) || value.warningTotal < value.warnings.length)) ||
    !Array.isArray(value.urls) ||
    !value.urls.every((item) => typeof item === 'string')
  )
    throw new Error('VALIDATION: Invalid durable collection result');
  return {
    recordCount: value.recordCount,
    requestCount: value.requestCount,
    browserUsed: value.browserUsed,
    aiUsed: value.aiUsed,
    ...(actionCache?.success ? { actionCache: actionCache.data } : {}),
    durationMs: value.durationMs,
    warnings: value.warnings,
    ...(value.warningTotal === undefined ? {} : { warningTotal: value.warningTotal }),
    urls: value.urls,
  };
}
