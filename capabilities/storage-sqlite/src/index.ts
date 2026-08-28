import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  PRODUCT_SCHEMA_VERSION,
  type AppendEventInput,
  type ClaimJobInput,
  type CreateArtifactInput,
  type EnqueueJobInput,
  type MigrationRecord,
  type PlatformArtifact,
  type PlatformEvent,
  type PlatformJob,
  type PlatformJobError,
  type PlatformJobState,
  type PlatformRepository,
} from '@zhiyun/platform-core';
import { completeSqliteV1Reset, prepareSqliteV1 } from './reset.js';
import { sqlitePlatformMigrations } from './schema.js';

type SqlRow = Record<string, unknown>;

export interface OpenSqlitePlatformRepositoryOptions {
  dataDirectory: string;
  filePath: string;
  graphRevision: string;
}

export async function openSqlitePlatformRepository(
  options: OpenSqlitePlatformRepositoryOptions,
): Promise<SqlitePlatformRepository> {
  const prepared = await prepareSqliteV1(options);
  const repository = new SqlitePlatformRepository(options.filePath);
  try {
    await repository.initialize(options.graphRevision);
    await completeSqliteV1Reset(prepared.markerPath);
    return repository;
  } catch (error) {
    await repository.close();
    throw error;
  }
}

export class SqlitePlatformRepository implements PlatformRepository {
  private readonly sqlite: Database.Database;

  constructor(filePath: string) {
    this.sqlite = new Database(filePath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
  }

  async initialize(graphRevision: string): Promise<void> {
    const hasLedger = Boolean(
      this.sqlite
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='plugin_migrations'")
        .get(),
    );
    if (!hasLedger) this.applyInitialMigration();
    const meta = this.sqlite.prepare('SELECT * FROM zhiyun_meta WHERE id=1').get() as
      SqlRow | undefined;
    if (!meta) {
      const now = new Date().toISOString();
      this.sqlite
        .prepare(
          'INSERT INTO zhiyun_meta(id,product_schema_version,graph_revision,created_at,updated_at) VALUES (1,?,?,?,?)',
        )
        .run(PRODUCT_SCHEMA_VERSION, graphRevision, now, now);
    } else if (meta.product_schema_version !== PRODUCT_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported product schema ${String(meta.product_schema_version)}; expected ${PRODUCT_SCHEMA_VERSION}`,
      );
    } else {
      this.sqlite
        .prepare('UPDATE zhiyun_meta SET graph_revision=?,updated_at=? WHERE id=1')
        .run(graphRevision, new Date().toISOString());
    }
    this.verifyMigrationChecksums();
  }

  private applyInitialMigration(): void {
    const migration = sqlitePlatformMigrations[0];
    const checksum = sha256(migration.sql);
    const started = performance.now();
    this.sqlite.transaction(() => {
      this.sqlite.exec(migration.sql);
      this.sqlite
        .prepare(
          `INSERT INTO plugin_migrations(
             plugin_id,migration_id,plugin_version,checksum,executed_at,duration_ms,result
           ) VALUES (?,?,?,?,?,?,?)`,
        )
        .run(
          migration.pluginId,
          migration.migrationId,
          migration.pluginVersion,
          checksum,
          new Date().toISOString(),
          Math.max(0, Math.round(performance.now() - started)),
          'succeeded',
        );
    })();
  }

  private verifyMigrationChecksums(): void {
    const known = new Map(
      sqlitePlatformMigrations.map((migration) => [
        `${migration.pluginId}:${migration.migrationId}`,
        sha256(migration.sql),
      ]),
    );
    const rows = this.sqlite.prepare('SELECT * FROM plugin_migrations').all() as SqlRow[];
    for (const row of rows) {
      const key = `${String(row.plugin_id)}:${String(row.migration_id)}`;
      const checksum = known.get(key);
      if (checksum && checksum !== row.checksum) {
        throw new Error(`Migration checksum mismatch for ${key}`);
      }
    }
  }

  async close(): Promise<void> {
    if (this.sqlite.open) this.sqlite.close();
  }

  async enqueueJob(input: EnqueueJobInput): Promise<PlatformJob> {
    const now = new Date().toISOString();
    const id = input.id ?? randomUUID();
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          `INSERT INTO platform_jobs(
             id,owner_plugin_id,type,payload,resource_class,state,progress,phase,attempt,max_attempts,
             available_at,lease_owner,lease_expires_at,cancel_requested_at,error,created_at,updated_at
           ) VALUES (?,?,?,?,?,'queued',0,'queued',0,?,?,NULL,NULL,NULL,NULL,?,?)`,
        )
        .run(
          id,
          input.ownerPluginId,
          input.type,
          JSON.stringify(input.payload),
          input.resourceClass,
          input.maxAttempts ?? 1,
          input.availableAt ?? now,
          now,
          now,
        );
      this.sqlite
        .prepare(
          `INSERT INTO platform_events(
             id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
           ) VALUES (?,'platform.job.created',1,'platform','platform-job',?,?,?)`,
        )
        .run(
          randomUUID(),
          id,
          JSON.stringify({ jobType: input.type, resourceClass: input.resourceClass }),
          now,
        );
    })();
    return (await this.getJob(id))!;
  }

  async getJob(id: string): Promise<PlatformJob | null> {
    return jobRow(
      this.sqlite.prepare('SELECT * FROM platform_jobs WHERE id=?').get(id) as SqlRow | undefined,
    );
  }

  async listJobs(
    options: {
      ownerPluginId?: string;
      states?: readonly PlatformJobState[];
      limit?: number;
    } = {},
  ): Promise<PlatformJob[]> {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (options.ownerPluginId) {
      clauses.push('owner_plugin_id=?');
      parameters.push(options.ownerPluginId);
    }
    if (options.states?.length) {
      clauses.push(`state IN (${options.states.map(() => '?').join(',')})`);
      parameters.push(...options.states);
    }
    parameters.push(Math.min(Math.max(options.limit ?? 100, 1), 1_000));
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM platform_jobs ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...parameters) as SqlRow[];
    return rows.map((row) => jobRow(row)!);
  }

  async claimJob(input: ClaimJobInput): Promise<PlatformJob | null> {
    if (input.resourceClasses.length === 0) return null;
    return this.sqlite.transaction(() => {
      const now = new Date();
      const idClause = input.jobId ? ' AND id=?' : '';
      const parameters: unknown[] = [now.toISOString(), ...input.resourceClasses];
      if (input.jobId) parameters.push(input.jobId);
      const row = this.sqlite
        .prepare(
          `SELECT * FROM platform_jobs
           WHERE state='queued' AND available_at<=? AND resource_class IN (${input.resourceClasses.map(() => '?').join(',')})
           ${idClause}
           ORDER BY available_at,created_at LIMIT 1`,
        )
        .get(...parameters) as SqlRow | undefined;
      if (!row) return null;
      const result = this.sqlite
        .prepare(
          `UPDATE platform_jobs SET state='claimed',phase='claimed',attempt=attempt+1,
           lease_owner=?,lease_expires_at=?,updated_at=? WHERE id=? AND state='queued'`,
        )
        .run(
          input.workerId,
          new Date(now.getTime() + input.leaseMs).toISOString(),
          now.toISOString(),
          row.id,
        );
      if (result.changes !== 1) return null;
      return jobRow(
        this.sqlite.prepare('SELECT * FROM platform_jobs WHERE id=?').get(row.id) as SqlRow,
      )!;
    })();
  }

  async startJob(id: string, workerId: string, leaseMs: number): Promise<PlatformJob | null> {
    const now = new Date();
    const result = this.sqlite
      .prepare(
        `UPDATE platform_jobs SET state='running',phase='running',lease_expires_at=?,updated_at=?
         WHERE id=? AND state='claimed' AND lease_owner=?`,
      )
      .run(new Date(now.getTime() + leaseMs).toISOString(), now.toISOString(), id, workerId);
    return result.changes === 1 ? this.getJob(id) : null;
  }

  async heartbeatJob(
    id: string,
    workerId: string,
    leaseMs: number,
  ): Promise<{ cancelRequested: boolean } | null> {
    const now = new Date();
    const result = this.sqlite
      .prepare(
        `UPDATE platform_jobs SET lease_expires_at=?,updated_at=?
         WHERE id=? AND lease_owner=? AND state IN ('running','persisting','canceling')`,
      )
      .run(new Date(now.getTime() + leaseMs).toISOString(), now.toISOString(), id, workerId);
    if (result.changes !== 1) return null;
    const row = this.sqlite
      .prepare('SELECT cancel_requested_at FROM platform_jobs WHERE id=?')
      .get(id) as SqlRow;
    return { cancelRequested: Boolean(row.cancel_requested_at) };
  }

  async updateJobProgress(
    id: string,
    workerId: string,
    progress: number,
    phase: string,
  ): Promise<PlatformJob | null> {
    const result = this.sqlite
      .prepare(
        `UPDATE platform_jobs SET progress=?,phase=?,updated_at=?
         WHERE id=? AND lease_owner=? AND state IN ('running','persisting','canceling')`,
      )
      .run(
        Math.min(Math.max(progress, 0), 1),
        phase.slice(0, 100),
        new Date().toISOString(),
        id,
        workerId,
      );
    return result.changes === 1 ? this.getJob(id) : null;
  }

  async markJobPersisting(id: string, workerId: string): Promise<PlatformJob | null> {
    return this.transitionOwnedJob(id, workerId, ['running'], 'persisting', 'persisting');
  }

  async completeJob(id: string, workerId: string): Promise<PlatformJob | null> {
    const now = new Date().toISOString();
    const result = this.sqlite
      .prepare(
        `UPDATE platform_jobs SET state='succeeded',phase='completed',progress=1,
         lease_owner=NULL,lease_expires_at=NULL,updated_at=?
         WHERE id=? AND lease_owner=? AND state IN ('running','persisting')`,
      )
      .run(now, id, workerId);
    return result.changes === 1 ? this.getJob(id) : null;
  }

  async failJob(
    id: string,
    workerId: string,
    error: PlatformJobError,
  ): Promise<PlatformJob | null> {
    return this.sqlite.transaction(() => {
      const row = this.sqlite.prepare('SELECT * FROM platform_jobs WHERE id=?').get(id) as
        SqlRow | undefined;
      if (!row || row.lease_owner !== workerId) return null;
      const retry = error.retryable && Number(row.attempt) < Number(row.max_attempts);
      const now = new Date();
      this.sqlite
        .prepare(
          `UPDATE platform_jobs SET state=?,phase=?,available_at=?,lease_owner=NULL,
           lease_expires_at=NULL,error=?,updated_at=? WHERE id=? AND lease_owner=?`,
        )
        .run(
          retry ? 'queued' : 'failed',
          retry ? 'retrying' : 'failed',
          new Date(
            now.getTime() + (retry ? 1_000 * 2 ** Math.max(0, Number(row.attempt) - 1) : 0),
          ).toISOString(),
          JSON.stringify(error),
          now.toISOString(),
          id,
          workerId,
        );
      return jobRow(
        this.sqlite.prepare('SELECT * FROM platform_jobs WHERE id=?').get(id) as SqlRow,
      )!;
    })();
  }

  async requestJobCancel(id: string): Promise<PlatformJob | null> {
    const now = new Date().toISOString();
    const result = this.sqlite
      .prepare(
        `UPDATE platform_jobs SET
           state=CASE WHEN state IN ('queued','claimed') THEN 'canceled' ELSE 'canceling' END,
           phase=CASE WHEN state IN ('queued','claimed') THEN 'canceled' ELSE 'canceling' END,
           lease_owner=CASE WHEN state IN ('queued','claimed') THEN NULL ELSE lease_owner END,
           lease_expires_at=CASE WHEN state IN ('queued','claimed') THEN NULL ELSE lease_expires_at END,
           cancel_requested_at=?,updated_at=?
         WHERE id=? AND state IN ('queued','claimed','running','persisting')`,
      )
      .run(now, now, id);
    return result.changes === 1 ? this.getJob(id) : null;
  }

  async markJobCanceled(id: string, workerId?: string): Promise<PlatformJob | null> {
    const parameters: unknown[] = [new Date().toISOString(), id];
    const ownerClause = workerId ? ' AND lease_owner=?' : '';
    if (workerId) parameters.push(workerId);
    const result = this.sqlite
      .prepare(
        `UPDATE platform_jobs SET state='canceled',phase='canceled',lease_owner=NULL,
         lease_expires_at=NULL,updated_at=? WHERE id=?${ownerClause}
         AND state IN ('queued','claimed','running','persisting','canceling','interrupted')`,
      )
      .run(...parameters);
    return result.changes === 1 ? this.getJob(id) : null;
  }

  async recoverExpiredJobs(now = new Date().toISOString()): Promise<number> {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM platform_jobs WHERE state IN ('claimed','running','persisting','canceling')
         AND lease_expires_at IS NOT NULL AND lease_expires_at<=?`,
      )
      .all(now) as SqlRow[];
    return this.sqlite.transaction(() => {
      for (const row of rows) {
        const canceled = row.state === 'canceling' || Boolean(row.cancel_requested_at);
        const retry = !canceled && Number(row.attempt) < Number(row.max_attempts);
        const state = canceled ? 'canceled' : retry ? 'queued' : 'failed';
        this.sqlite
          .prepare(
            `UPDATE platform_jobs SET state=?,phase=?,lease_owner=NULL,lease_expires_at=NULL,
             error=?,updated_at=? WHERE id=?`,
          )
          .run(
            state,
            canceled ? 'canceled' : retry ? 'recovered' : 'failed',
            canceled
              ? row.error
              : JSON.stringify({
                  code: 'JOB_INTERRUPTED',
                  message: 'Job lease expired',
                  retryable: retry,
                }),
            now,
            row.id,
          );
      }
      return rows.length;
    })();
  }

  async appendEvent(input: AppendEventInput): Promise<PlatformEvent> {
    const id = input.id ?? randomUUID();
    this.sqlite
      .prepare(
        `INSERT INTO platform_events(
           id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
         ) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.type,
        input.schemaVersion ?? 1,
        input.producerPluginId,
        input.aggregateType,
        input.aggregateId,
        JSON.stringify(input.payload),
        input.occurredAt ?? new Date().toISOString(),
      );
    return eventRow(
      this.sqlite.prepare('SELECT * FROM platform_events WHERE id=?').get(id) as SqlRow,
    );
  }

  async listEvents(afterCursor: number, limit: number): Promise<PlatformEvent[]> {
    return (
      this.sqlite
        .prepare('SELECT * FROM platform_events WHERE cursor>? ORDER BY cursor LIMIT ?')
        .all(afterCursor, Math.min(Math.max(limit, 1), 1_000)) as SqlRow[]
    ).map(eventRow);
  }

  async getConsumerCheckpoint(consumerId: string): Promise<number> {
    const row = this.sqlite
      .prepare('SELECT cursor FROM event_consumer_checkpoints WHERE consumer_id=?')
      .get(consumerId) as SqlRow | undefined;
    return Number(row?.cursor ?? 0);
  }

  async saveConsumerCheckpoint(consumerId: string, cursor: number): Promise<void> {
    this.sqlite
      .prepare(
        `INSERT INTO event_consumer_checkpoints(consumer_id,cursor,updated_at) VALUES (?,?,?)
         ON CONFLICT(consumer_id) DO UPDATE SET
           cursor=MAX(event_consumer_checkpoints.cursor,excluded.cursor),updated_at=excluded.updated_at`,
      )
      .run(consumerId, cursor, new Date().toISOString());
  }

  async recordDeadLetter(input: {
    consumerId: string;
    event: PlatformEvent;
    error: string;
  }): Promise<number> {
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO event_dead_letters(
           consumer_id,event_id,event_cursor,event_type,error,attempts,first_failed_at,last_failed_at
         ) VALUES (?,?,?,?,?,1,?,?)
         ON CONFLICT(consumer_id,event_id) DO UPDATE SET
           error=excluded.error,attempts=event_dead_letters.attempts+1,last_failed_at=excluded.last_failed_at`,
      )
      .run(
        input.consumerId,
        input.event.id,
        input.event.cursor,
        input.event.type,
        input.error.slice(0, 2_000),
        now,
        now,
      );
    const row = this.sqlite
      .prepare('SELECT attempts FROM event_dead_letters WHERE consumer_id=? AND event_id=?')
      .get(input.consumerId, input.event.id) as SqlRow;
    return Number(row.attempts);
  }

  async createArtifact(input: CreateArtifactInput): Promise<PlatformArtifact> {
    const id = input.id ?? randomUUID();
    this.sqlite
      .prepare(
        `INSERT INTO platform_artifacts(
           id,owner_plugin_id,kind,filename,content_type,size,checksum,storage_key,metadata,created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.ownerPluginId,
        input.kind,
        input.filename,
        input.contentType,
        input.size,
        input.checksum,
        input.storageKey,
        JSON.stringify(input.metadata),
        input.createdAt ?? new Date().toISOString(),
      );
    return (await this.getArtifact(id))!;
  }

  async getArtifact(id: string): Promise<PlatformArtifact | null> {
    const row = this.sqlite.prepare('SELECT * FROM platform_artifacts WHERE id=?').get(id) as
      SqlRow | undefined;
    return row ? artifactRow(row) : null;
  }

  async listMigrations(): Promise<MigrationRecord[]> {
    return (
      this.sqlite
        .prepare('SELECT * FROM plugin_migrations ORDER BY plugin_id,migration_id')
        .all() as SqlRow[]
    ).map((row) => ({
      pluginId: String(row.plugin_id),
      migrationId: String(row.migration_id),
      pluginVersion: String(row.plugin_version),
      checksum: String(row.checksum),
      executedAt: String(row.executed_at),
      durationMs: Number(row.duration_ms),
      result: row.result as MigrationRecord['result'],
    }));
  }

  private async transitionOwnedJob(
    id: string,
    workerId: string,
    from: PlatformJobState[],
    to: PlatformJobState,
    phase: string,
  ): Promise<PlatformJob | null> {
    const result = this.sqlite
      .prepare(
        `UPDATE platform_jobs SET state=?,phase=?,updated_at=? WHERE id=? AND lease_owner=?
         AND state IN (${from.map(() => '?').join(',')})`,
      )
      .run(to, phase, new Date().toISOString(), id, workerId, ...from);
    return result.changes === 1 ? this.getJob(id) : null;
  }
}

function jobRow(row: SqlRow | undefined): PlatformJob | null {
  if (!row) return null;
  return {
    id: String(row.id),
    ownerPluginId: String(row.owner_plugin_id),
    type: String(row.type),
    payload: parseObject(row.payload),
    resourceClass: row.resource_class as PlatformJob['resourceClass'],
    state: row.state as PlatformJobState,
    progress: Number(row.progress),
    phase: String(row.phase),
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    availableAt: String(row.available_at),
    leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
    leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null,
    cancelRequestedAt: row.cancel_requested_at ? String(row.cancel_requested_at) : null,
    error: row.error ? (JSON.parse(String(row.error)) as PlatformJobError) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function eventRow(row: SqlRow): PlatformEvent {
  return {
    id: String(row.id),
    cursor: Number(row.cursor),
    type: String(row.type),
    schemaVersion: Number(row.schema_version),
    producerPluginId: String(row.producer_plugin_id),
    aggregateType: String(row.aggregate_type),
    aggregateId: String(row.aggregate_id),
    payload: parseObject(row.payload),
    occurredAt: String(row.occurred_at),
  };
}

function artifactRow(row: SqlRow): PlatformArtifact {
  return {
    id: String(row.id),
    ownerPluginId: String(row.owner_plugin_id),
    kind: String(row.kind),
    filename: String(row.filename),
    contentType: String(row.content_type),
    size: Number(row.size),
    checksum: String(row.checksum),
    storageKey: String(row.storage_key),
    metadata: parseObject(row.metadata),
    createdAt: String(row.created_at),
  };
}

function parseObject(value: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(String(value));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export { prepareSqliteV1 } from './reset.js';
export { sqlitePlatformMigrations } from './schema.js';
