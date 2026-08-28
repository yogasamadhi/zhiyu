import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import {
  LEGACY_TABLES,
  PRODUCT_SCHEMA_VERSION,
  type AppendEventInput,
  type ClaimJobInput,
  type CreateArtifactInput,
  type EnqueueJobInput,
  type IdempotencyReservation,
  type MigrationRecord,
  type PlatformArtifact,
  type PlatformEvent,
  type PlatformJob,
  type PlatformJobError,
  type PlatformJobState,
  type PlatformRepository,
} from '@zhiyun/platform-core';
import { postgresPlatformMigrations } from './schema.js';

type PgRow = Record<string, unknown>;
type PostgresClient = ReturnType<typeof postgres>;

export interface OpenPostgresPlatformRepositoryOptions {
  connectionString: string;
  graphRevision: string;
  maxConnections?: number;
}

export async function openPostgresPlatformRepository(
  options: OpenPostgresPlatformRepositoryOptions,
): Promise<PostgresPlatformRepository> {
  const repository = new PostgresPlatformRepository(
    options.connectionString,
    options.maxConnections,
  );
  try {
    await repository.initialize(options.graphRevision);
    return repository;
  } catch (error) {
    await repository.close();
    throw error;
  }
}

export class PostgresPlatformRepository implements PlatformRepository {
  private readonly sql: PostgresClient;

  constructor(connectionString: string, maxConnections = 10) {
    this.sql = postgres(connectionString, { max: maxConnections });
  }

  async initialize(graphRevision: string): Promise<void> {
    const tables = await this.listPublicTables();
    if (!tables.includes('zhiyun_meta')) {
      const legacy = isLegacySchema(tables);
      if (tables.length > 0 && !legacy) {
        throw new Error(
          `Unknown PostgreSQL schema; refusing destructive reset: ${tables.sort().join(', ')}`,
        );
      }
      const dropTables = legacy ? tables.filter((table) => LEGACY_TABLES.includes(table)) : [];
      await this.installInitialSchema(graphRevision, dropTables);
      return;
    }

    const rows = await this.sql`SELECT * FROM zhiyun_meta WHERE id=1`;
    const meta = rows[0] as PgRow | undefined;
    if (!meta) throw new Error('Invalid PostgreSQL v1 schema: zhiyun_meta row is missing');
    if (meta.product_schema_version !== PRODUCT_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported product schema ${String(meta.product_schema_version)}; expected ${PRODUCT_SCHEMA_VERSION}`,
      );
    }
    await this.verifyMigrationChecksums();
    await this.sql`
      UPDATE zhiyun_meta
      SET graph_revision=${graphRevision},updated_at=${new Date()}
      WHERE id=1
    `;
  }

  private async listPublicTables(): Promise<string[]> {
    const rows = await this.sql`
      SELECT tablename
      FROM pg_catalog.pg_tables
      WHERE schemaname='public'
    `;
    return rows.map((row) => String(row.tablename));
  }

  private async installInitialSchema(graphRevision: string, dropTables: string[]): Promise<void> {
    const migration = postgresPlatformMigrations[0];
    const checksum = sha256(migration.sql);
    const started = performance.now();
    await this.sql.begin(async (transaction) => {
      if (dropTables.length > 0) {
        const identifiers = dropTables.map(quoteKnownIdentifier).join(',');
        await transaction.unsafe(`DROP TABLE ${identifiers}`);
      }
      await transaction.unsafe(migration.sql);
      const now = new Date();
      await transaction`
        INSERT INTO plugin_migrations(
          plugin_id,migration_id,plugin_version,checksum,executed_at,duration_ms,result
        ) VALUES (
          ${migration.pluginId},${migration.migrationId},${migration.pluginVersion},${checksum},
          ${now},${Math.max(0, Math.round(performance.now() - started))},'succeeded'
        )
      `;
      await transaction`
        INSERT INTO zhiyun_meta(
          id,product_schema_version,graph_revision,created_at,updated_at
        ) VALUES (1,${PRODUCT_SCHEMA_VERSION},${graphRevision},${now},${now})
      `;
    });
  }

  private async verifyMigrationChecksums(): Promise<void> {
    const known = new Map(
      postgresPlatformMigrations.map((migration) => [
        `${migration.pluginId}:${migration.migrationId}`,
        sha256(migration.sql),
      ]),
    );
    const rows = await this.sql`SELECT * FROM plugin_migrations`;
    for (const row of rows) {
      const key = `${String(row.plugin_id)}:${String(row.migration_id)}`;
      const checksum = known.get(key);
      if (checksum && checksum !== row.checksum) {
        throw new Error(`Migration checksum mismatch for ${key}`);
      }
    }
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  async enqueueJob(input: EnqueueJobInput): Promise<PlatformJob> {
    const now = new Date();
    const id = input.id ?? randomUUID();
    return this.sql.begin(async (transaction) => {
      const rows = await transaction`
        INSERT INTO platform_jobs(
          id,owner_plugin_id,type,payload,resource_class,state,progress,phase,attempt,max_attempts,
          available_at,lease_owner,lease_expires_at,cancel_requested_at,error,created_at,updated_at
        ) VALUES (
          ${id},${input.ownerPluginId},${input.type},${transaction.json(jsonValue(input.payload))},
          ${input.resourceClass},'queued',0,'queued',0,${input.maxAttempts ?? 1},
          ${input.availableAt ? new Date(input.availableAt) : now},NULL,NULL,NULL,NULL,${now},${now}
        ) RETURNING *
      `;
      await transaction`
        INSERT INTO platform_events(
          id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
        ) VALUES (
          ${randomUUID()},'platform.job.created',1,'platform','platform-job',${id},
          ${transaction.json(
            jsonValue({ jobType: input.type, resourceClass: input.resourceClass }),
          )},${now}
        )
      `;
      return jobRow(rows[0] as PgRow);
    });
  }

  async getJob(id: string): Promise<PlatformJob | null> {
    const rows = await this.sql`SELECT * FROM platform_jobs WHERE id=${id}`;
    return rows[0] ? jobRow(rows[0] as PgRow) : null;
  }

  async listJobs(
    options: {
      ownerPluginId?: string;
      states?: readonly PlatformJobState[];
      limit?: number;
    } = {},
  ): Promise<PlatformJob[]> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1_000);
    const rows = options.ownerPluginId
      ? options.states?.length
        ? await this.sql`
            SELECT * FROM platform_jobs
            WHERE owner_plugin_id=${options.ownerPluginId}
              AND state=ANY(${this.sql.array([...options.states])})
            ORDER BY created_at DESC LIMIT ${limit}
          `
        : await this.sql`
            SELECT * FROM platform_jobs WHERE owner_plugin_id=${options.ownerPluginId}
            ORDER BY created_at DESC LIMIT ${limit}
          `
      : options.states?.length
        ? await this.sql`
            SELECT * FROM platform_jobs WHERE state=ANY(${this.sql.array([...options.states])})
            ORDER BY created_at DESC LIMIT ${limit}
          `
        : await this.sql`SELECT * FROM platform_jobs ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map((row) => jobRow(row as PgRow));
  }

  async claimJob(input: ClaimJobInput): Promise<PlatformJob | null> {
    if (input.resourceClasses.length === 0) return null;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.leaseMs);
    const rows = await this.sql`
      UPDATE platform_jobs SET
        state='claimed',phase='claimed',attempt=attempt+1,lease_owner=${input.workerId},
        lease_expires_at=${expiresAt},updated_at=${now}
      WHERE id=(
        SELECT id FROM platform_jobs
        WHERE state='queued' AND available_at<=${now}
          AND resource_class=ANY(${this.sql.array([...input.resourceClasses])})
          AND (${!input.jobId} OR id=${input.jobId ?? ''})
        ORDER BY available_at,created_at
        FOR UPDATE SKIP LOCKED LIMIT 1
      )
      RETURNING *
    `;
    return rows[0] ? jobRow(rows[0] as PgRow) : null;
  }

  async startJob(id: string, workerId: string, leaseMs: number): Promise<PlatformJob | null> {
    const now = new Date();
    const rows = await this.sql`
      UPDATE platform_jobs SET
        state='running',phase='running',lease_expires_at=${new Date(now.getTime() + leaseMs)},
        updated_at=${now}
      WHERE id=${id} AND state='claimed' AND lease_owner=${workerId}
      RETURNING *
    `;
    return rows[0] ? jobRow(rows[0] as PgRow) : null;
  }

  async heartbeatJob(
    id: string,
    workerId: string,
    leaseMs: number,
  ): Promise<{ cancelRequested: boolean } | null> {
    const now = new Date();
    const rows = await this.sql`
      UPDATE platform_jobs SET
        lease_expires_at=${new Date(now.getTime() + leaseMs)},updated_at=${now}
      WHERE id=${id} AND lease_owner=${workerId}
        AND state IN ('running','persisting','canceling')
      RETURNING cancel_requested_at
    `;
    return rows[0] ? { cancelRequested: Boolean(rows[0].cancel_requested_at) } : null;
  }

  async updateJobProgress(
    id: string,
    workerId: string,
    progress: number,
    phase: string,
  ): Promise<PlatformJob | null> {
    const rows = await this.sql`
      UPDATE platform_jobs SET
        progress=${Math.min(Math.max(progress, 0), 1)},phase=${phase.slice(0, 100)},
        updated_at=${new Date()}
      WHERE id=${id} AND lease_owner=${workerId}
        AND state IN ('running','persisting','canceling')
      RETURNING *
    `;
    return rows[0] ? jobRow(rows[0] as PgRow) : null;
  }

  async markJobPersisting(id: string, workerId: string): Promise<PlatformJob | null> {
    return this.transitionOwnedJob(id, workerId, ['running'], 'persisting', 'persisting');
  }

  async completeJob(id: string, workerId: string): Promise<PlatformJob | null> {
    const rows = await this.sql`
      UPDATE platform_jobs SET
        state='succeeded',phase='completed',progress=1,lease_owner=NULL,
        lease_expires_at=NULL,updated_at=${new Date()}
      WHERE id=${id} AND lease_owner=${workerId} AND state IN ('running','persisting')
      RETURNING *
    `;
    return rows[0] ? jobRow(rows[0] as PgRow) : null;
  }

  async failJob(
    id: string,
    workerId: string,
    error: PlatformJobError,
  ): Promise<PlatformJob | null> {
    return this.sql.begin(async (transaction) => {
      const selected = await transaction`
        SELECT * FROM platform_jobs WHERE id=${id} AND lease_owner=${workerId} FOR UPDATE
      `;
      const row = selected[0] as PgRow | undefined;
      if (!row) return null;
      const retry = error.retryable && Number(row.attempt) < Number(row.max_attempts);
      const now = new Date();
      const availableAt = new Date(
        now.getTime() + (retry ? 1_000 * 2 ** Math.max(0, Number(row.attempt) - 1) : 0),
      );
      const rows = await transaction`
        UPDATE platform_jobs SET
          state=${retry ? 'queued' : 'failed'},phase=${retry ? 'retrying' : 'failed'},
          available_at=${availableAt},lease_owner=NULL,lease_expires_at=NULL,
          error=${transaction.json(jsonValue(error))},updated_at=${now}
        WHERE id=${id} AND lease_owner=${workerId}
        RETURNING *
      `;
      return rows[0] ? jobRow(rows[0] as PgRow) : null;
    });
  }

  async requestJobCancel(id: string): Promise<PlatformJob | null> {
    const now = new Date();
    const rows = await this.sql`
      UPDATE platform_jobs SET
        state=CASE WHEN state IN ('queued','claimed') THEN 'canceled' ELSE 'canceling' END,
        phase=CASE WHEN state IN ('queued','claimed') THEN 'canceled' ELSE 'canceling' END,
        lease_owner=CASE WHEN state IN ('queued','claimed') THEN NULL ELSE lease_owner END,
        lease_expires_at=CASE WHEN state IN ('queued','claimed') THEN NULL ELSE lease_expires_at END,
        cancel_requested_at=${now},updated_at=${now}
      WHERE id=${id} AND state IN ('queued','claimed','running','persisting')
      RETURNING *
    `;
    return rows[0] ? jobRow(rows[0] as PgRow) : null;
  }

  async markJobCanceled(id: string, workerId?: string): Promise<PlatformJob | null> {
    const rows = workerId
      ? await this.sql`
          UPDATE platform_jobs SET state='canceled',phase='canceled',lease_owner=NULL,
            lease_expires_at=NULL,updated_at=${new Date()}
          WHERE id=${id} AND lease_owner=${workerId}
            AND state IN ('queued','claimed','running','persisting','canceling','interrupted')
          RETURNING *
        `
      : await this.sql`
          UPDATE platform_jobs SET state='canceled',phase='canceled',lease_owner=NULL,
            lease_expires_at=NULL,updated_at=${new Date()}
          WHERE id=${id}
            AND state IN ('queued','claimed','running','persisting','canceling','interrupted')
          RETURNING *
        `;
    return rows[0] ? jobRow(rows[0] as PgRow) : null;
  }

  async recoverExpiredJobs(now = new Date().toISOString()): Promise<number> {
    const rows = await this.sql`
      UPDATE platform_jobs SET
        state=CASE
          WHEN state='canceling' OR cancel_requested_at IS NOT NULL THEN 'canceled'
          WHEN attempt<max_attempts THEN 'queued'
          ELSE 'failed'
        END,
        phase=CASE
          WHEN state='canceling' OR cancel_requested_at IS NOT NULL THEN 'canceled'
          WHEN attempt<max_attempts THEN 'recovered'
          ELSE 'failed'
        END,
        error=CASE
          WHEN state='canceling' OR cancel_requested_at IS NOT NULL THEN error
          ELSE jsonb_build_object(
            'code','JOB_INTERRUPTED','message','Job lease expired',
            'retryable',attempt<max_attempts
          )
        END,
        lease_owner=NULL,lease_expires_at=NULL,updated_at=${new Date(now)}
      WHERE state IN ('claimed','running','persisting','canceling')
        AND lease_expires_at IS NOT NULL AND lease_expires_at<=${new Date(now)}
      RETURNING id
    `;
    return rows.length;
  }

  async appendEvent(input: AppendEventInput): Promise<PlatformEvent> {
    const rows = await this.sql`
      INSERT INTO platform_events(
        id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
      ) VALUES (
        ${input.id ?? randomUUID()},${input.type},${input.schemaVersion ?? 1},
        ${input.producerPluginId},${input.aggregateType},${input.aggregateId},
        ${this.sql.json(jsonValue(input.payload))},${input.occurredAt ? new Date(input.occurredAt) : new Date()}
      ) RETURNING *
    `;
    return eventRow(rows[0] as PgRow);
  }

  async listEvents(afterCursor: number, limit: number): Promise<PlatformEvent[]> {
    const rows = await this.sql`
      SELECT * FROM platform_events WHERE cursor>${afterCursor}
      ORDER BY cursor LIMIT ${Math.min(Math.max(limit, 1), 1_000)}
    `;
    return rows.map((row) => eventRow(row as PgRow));
  }

  async getConsumerCheckpoint(consumerId: string): Promise<number> {
    const rows = await this.sql`
      SELECT cursor FROM event_consumer_checkpoints WHERE consumer_id=${consumerId}
    `;
    return Number(rows[0]?.cursor ?? 0);
  }

  async saveConsumerCheckpoint(consumerId: string, cursor: number): Promise<void> {
    await this.sql`
      INSERT INTO event_consumer_checkpoints(consumer_id,cursor,updated_at)
      VALUES (${consumerId},${cursor},${new Date()})
      ON CONFLICT(consumer_id) DO UPDATE SET
        cursor=GREATEST(event_consumer_checkpoints.cursor,EXCLUDED.cursor),
        updated_at=EXCLUDED.updated_at
    `;
  }

  async recordDeadLetter(input: {
    consumerId: string;
    event: PlatformEvent;
    error: string;
  }): Promise<number> {
    const now = new Date();
    const rows = await this.sql`
      INSERT INTO event_dead_letters(
        consumer_id,event_id,event_cursor,event_type,error,attempts,first_failed_at,last_failed_at
      ) VALUES (
        ${input.consumerId},${input.event.id},${input.event.cursor},${input.event.type},
        ${input.error.slice(0, 2_000)},1,${now},${now}
      )
      ON CONFLICT(consumer_id,event_id) DO UPDATE SET
        error=EXCLUDED.error,attempts=event_dead_letters.attempts+1,
        last_failed_at=EXCLUDED.last_failed_at
      RETURNING attempts
    `;
    return Number(rows[0]?.attempts);
  }

  async createArtifact(input: CreateArtifactInput): Promise<PlatformArtifact> {
    const rows = await this.sql`
      INSERT INTO platform_artifacts(
        id,owner_plugin_id,kind,filename,content_type,size,checksum,storage_key,metadata,created_at
      ) VALUES (
        ${input.id ?? randomUUID()},${input.ownerPluginId},${input.kind},${input.filename},
        ${input.contentType},${input.size},${input.checksum},${input.storageKey},
        ${this.sql.json(jsonValue(input.metadata))},${input.createdAt ? new Date(input.createdAt) : new Date()}
      ) RETURNING *
    `;
    return artifactRow(rows[0] as PgRow);
  }

  async getArtifact(id: string): Promise<PlatformArtifact | null> {
    const rows = await this.sql`SELECT * FROM platform_artifacts WHERE id=${id}`;
    return rows[0] ? artifactRow(rows[0] as PgRow) : null;
  }

  async reserveIdempotency(input: {
    scope: string;
    key: string;
    requestHash: string;
    expiresAt: string;
  }): Promise<IdempotencyReservation> {
    return this.sql.begin(async (transaction) => {
      await transaction`DELETE FROM idempotency_keys WHERE expires_at<=${new Date()}`;
      const inserted = await transaction`
        INSERT INTO idempotency_keys(
          scope,key,request_hash,response_status,response_body,created_at,expires_at
        ) VALUES (
          ${input.scope},${input.key},${input.requestHash},NULL,NULL,${new Date()},${input.expiresAt}
        ) ON CONFLICT(scope,key) DO NOTHING RETURNING key
      `;
      if (inserted[0]) return { state: 'reserved' };
      const rows = await transaction`
        SELECT * FROM idempotency_keys WHERE scope=${input.scope} AND key=${input.key} FOR UPDATE
      `;
      const row = rows[0] as PgRow;
      if (row.request_hash !== input.requestHash) return { state: 'conflict' };
      if (row.response_status == null) return { state: 'pending' };
      return {
        state: 'completed',
        responseStatus: Number(row.response_status),
        responseBody: row.response_body,
      };
    });
  }

  async completeIdempotency(input: {
    scope: string;
    key: string;
    requestHash: string;
    responseStatus: number;
    responseBody: unknown;
  }): Promise<void> {
    const rows = await this.sql`
      UPDATE idempotency_keys SET
        response_status=${input.responseStatus},response_body=${this.sql.json(
          jsonValue(input.responseBody),
        )}
      WHERE scope=${input.scope} AND key=${input.key} AND request_hash=${input.requestHash}
        AND response_status IS NULL
      RETURNING key
    `;
    if (!rows[0]) {
      const existing = await this.reserveIdempotency({
        scope: input.scope,
        key: input.key,
        requestHash: input.requestHash,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
      if (existing.state !== 'completed') throw new Error('Idempotency reservation was lost');
    }
  }

  async getRuntimeSetting<T = unknown>(key: string): Promise<T | null> {
    const rows = await this.sql`SELECT value FROM runtime_settings WHERE key=${key}`;
    return rows[0] ? (rows[0].value as T) : null;
  }

  async setRuntimeSetting(key: string, value: unknown): Promise<void> {
    await this.sql`
      INSERT INTO runtime_settings(key,value,updated_at)
      VALUES (${key},${this.sql.json(jsonValue(value))},${new Date()})
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at
    `;
  }

  async listMigrations(): Promise<MigrationRecord[]> {
    const rows = await this.sql`
      SELECT * FROM plugin_migrations ORDER BY plugin_id,migration_id
    `;
    return rows.map((row) => ({
      pluginId: String(row.plugin_id),
      migrationId: String(row.migration_id),
      pluginVersion: String(row.plugin_version),
      checksum: String(row.checksum),
      executedAt: iso(row.executed_at),
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
    const rows = await this.sql`
      UPDATE platform_jobs SET state=${to},phase=${phase},updated_at=${new Date()}
      WHERE id=${id} AND lease_owner=${workerId} AND state=ANY(${this.sql.array(from)})
      RETURNING *
    `;
    return rows[0] ? jobRow(rows[0] as PgRow) : null;
  }
}

function isLegacySchema(tables: string[]): boolean {
  return ['tasks', 'rules', 'runs', 'records'].every((table) => tables.includes(table));
}

function quoteKnownIdentifier(identifier: string): string {
  if (!LEGACY_TABLES.includes(identifier) || !/^[a-z_]+$/.test(identifier)) {
    throw new Error(`Refusing unknown PostgreSQL reset table ${identifier}`);
  }
  return `"${identifier}"`;
}

function jobRow(row: PgRow): PlatformJob {
  return {
    id: String(row.id),
    ownerPluginId: String(row.owner_plugin_id),
    type: String(row.type),
    payload: objectValue(row.payload),
    resourceClass: row.resource_class as PlatformJob['resourceClass'],
    state: row.state as PlatformJobState,
    progress: Number(row.progress),
    phase: String(row.phase),
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    availableAt: iso(row.available_at),
    leaseOwner: nullableString(row.lease_owner),
    leaseExpiresAt: nullableIso(row.lease_expires_at),
    cancelRequestedAt: nullableIso(row.cancel_requested_at),
    error: row.error ? (objectValue(row.error) as unknown as PlatformJobError) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function eventRow(row: PgRow): PlatformEvent {
  return {
    id: String(row.id),
    cursor: Number(row.cursor),
    type: String(row.type),
    schemaVersion: Number(row.schema_version),
    producerPluginId: String(row.producer_plugin_id),
    aggregateType: String(row.aggregate_type),
    aggregateId: String(row.aggregate_id),
    payload: objectValue(row.payload),
    occurredAt: iso(row.occurred_at),
  };
}

function artifactRow(row: PgRow): PlatformArtifact {
  return {
    id: String(row.id),
    ownerPluginId: String(row.owner_plugin_id),
    kind: String(row.kind),
    filename: String(row.filename),
    contentType: String(row.content_type),
    size: Number(row.size),
    checksum: String(row.checksum),
    storageKey: String(row.storage_key),
    metadata: objectValue(row.metadata),
    createdAt: iso(row.created_at),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function jsonValue(value: unknown): Parameters<PostgresClient['json']>[0] {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Value is not JSON serializable');
  return JSON.parse(serialized) as Parameters<PostgresClient['json']>[0];
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export { postgresPlatformMigrations } from './schema.js';
