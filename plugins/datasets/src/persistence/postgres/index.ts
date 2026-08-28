import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { DatasetRecord, DatasetStats, RecordChange } from '@zhiyun/shared';
import type {
  Dataset,
  DatasetCommitInput,
  DatasetCommitResult,
  DatasetRecordPage,
  DatasetRepository,
  DatasetSnapshot,
  RecordChangePage,
} from '../../contracts/index.js';
import { datasetFingerprint, normalizeDatasetInputs } from '../../domain/index.js';
import { datasetsPostgresMigration001 } from '../../migrations/postgres/index.js';

type PgRow = Record<string, unknown>;
type PostgresClient = ReturnType<typeof postgres>;
const MIGRATION_ID = '001-initial';
const SCHEMA_VERSION = 1;

export class PostgresDatasetRepository implements DatasetRepository {
  private readonly sql: PostgresClient;

  constructor(connectionString: string, maxConnections = 5) {
    this.sql = postgres(connectionString, { max: maxConnections });
  }

  async migrate(): Promise<void> {
    const checksum = sha256(datasetsPostgresMigration001);
    const rows = await this.sql`
      SELECT checksum FROM plugin_migrations
      WHERE plugin_id='datasets' AND migration_id=${MIGRATION_ID}
    `;
    if (rows[0]) {
      if (rows[0].checksum !== checksum) {
        throw new Error('Migration checksum mismatch for datasets:001-initial');
      }
      return;
    }
    const started = performance.now();
    await this.sql.begin(async (transaction) => {
      await transaction.unsafe(datasetsPostgresMigration001);
      await transaction`
        INSERT INTO plugin_migrations(
          plugin_id,migration_id,plugin_version,checksum,executed_at,duration_ms,result
        ) VALUES (
          'datasets',${MIGRATION_ID},'1.0.0',${checksum},${new Date()},
          ${Math.max(0, Math.round(performance.now() - started))},'succeeded'
        )
      `;
    });
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  async commitRunRecords(input: DatasetCommitInput): Promise<DatasetCommitResult> {
    return this.sql.begin(async (transaction) => {
      await transaction`
        SELECT pg_advisory_xact_lock(hashtextextended(${input.sourceRunId},0))
      `;
      await transaction`
        SELECT pg_advisory_xact_lock(hashtextextended(${input.sourceTaskId},1))
      `;
      const existingSnapshots = await transaction`
        SELECT * FROM dataset_snapshots WHERE source_run_id=${input.sourceRunId}
      `;
      if (existingSnapshots[0]) {
        const snapshot = snapshotRow(existingSnapshots[0] as PgRow);
        const datasets = await transaction`
          SELECT * FROM datasets WHERE id=${snapshot.datasetId}
        `;
        return {
          dataset: datasetRow(datasets[0] as PgRow),
          snapshot,
          stats: snapshot.stats,
          reused: true,
        };
      }

      const timestamp = new Date();
      const selectedDatasets = await transaction`
        SELECT * FROM datasets WHERE source_task_id=${input.sourceTaskId} FOR UPDATE
      `;
      let dataset: Dataset;
      if (selectedDatasets[0]) {
        const rows = await transaction`
          UPDATE datasets SET
            settings=${transaction.json(jsonValue(input.settings))},updated_at=${timestamp}
          WHERE id=${String(selectedDatasets[0].id)} RETURNING *
        `;
        dataset = datasetRow(rows[0] as PgRow);
      } else {
        const rows = await transaction`
          INSERT INTO datasets(
            id,source_task_id,settings,schema_version,current_count,created_at,updated_at
          ) VALUES (
            ${randomUUID()},${input.sourceTaskId},${transaction.json(jsonValue(input.settings))},
            1,0,${timestamp},${timestamp}
          ) RETURNING *
        `;
        dataset = datasetRow(rows[0] as PgRow);
      }

      const normalized = normalizeDatasetInputs(input.sourceRunId, input.settings, input.records);
      const stats: DatasetStats = {
        added: 0,
        updated: 0,
        removed: 0,
        unchanged: 0,
        current: 0,
      };
      for (const record of normalized) {
        await transaction`
          INSERT INTO records(
            id,dataset_id,source_run_id,record_key,source_url,data,content_hash,created_at
          ) VALUES (
            ${randomUUID()},${dataset.id},${input.sourceRunId},${record.recordKey},
            ${record.sourceUrl},${transaction.json(jsonValue(record.data))},
            ${record.contentHash},${timestamp}
          ) ON CONFLICT(source_run_id,record_key) DO NOTHING
        `;
        const selected = await transaction`
          SELECT * FROM dataset_records
          WHERE dataset_id=${dataset.id} AND record_key=${record.recordKey} FOR UPDATE
        `;
        const existing = selected[0] as PgRow | undefined;
        if (!existing) {
          const recordId = randomUUID();
          await transaction`
            INSERT INTO dataset_records(
              id,dataset_id,source_task_id,record_key,source_url,data,content_hash,removed,
              first_run_id,last_run_id,first_seen_at,last_seen_at
            ) VALUES (
              ${recordId},${dataset.id},${input.sourceTaskId},${record.recordKey},
              ${record.sourceUrl},${transaction.json(jsonValue(record.data))},
              ${record.contentHash},false,${input.sourceRunId},${input.sourceRunId},
              ${timestamp},${timestamp}
            )
          `;
          await transaction`
            INSERT INTO record_changes(
              id,dataset_id,dataset_record_id,source_run_id,type,before,after,created_at
            ) VALUES (
              ${randomUUID()},${dataset.id},${recordId},${input.sourceRunId},'added',NULL,
              ${transaction.json(jsonValue(record.data))},${timestamp}
            )
          `;
          stats.added += 1;
        } else if (
          String(existing.content_hash) !== record.contentHash ||
          Boolean(existing.removed)
        ) {
          await transaction`
            UPDATE dataset_records SET
              source_url=${record.sourceUrl},data=${transaction.json(jsonValue(record.data))},
              content_hash=${record.contentHash},removed=false,last_run_id=${input.sourceRunId},
              last_seen_at=${timestamp}
            WHERE id=${String(existing.id)}
          `;
          await transaction`
            INSERT INTO record_changes(
              id,dataset_id,dataset_record_id,source_run_id,type,before,after,created_at
            ) VALUES (
              ${randomUUID()},${dataset.id},${String(existing.id)},${input.sourceRunId},'updated',
              ${transaction.json(jsonValue(objectValue(existing.data)))},
              ${transaction.json(jsonValue(record.data))},${timestamp}
            )
          `;
          stats.updated += 1;
        } else {
          await transaction`
            UPDATE dataset_records SET
              removed=false,last_run_id=${input.sourceRunId},last_seen_at=${timestamp}
            WHERE id=${String(existing.id)}
          `;
          stats.unchanged += 1;
        }
      }

      if (input.settings.mode === 'snapshot' && input.settings.detectRemoved) {
        const stale = await transaction`
          SELECT * FROM dataset_records
          WHERE dataset_id=${dataset.id} AND removed=false
            AND (last_run_id IS NULL OR last_run_id<>${input.sourceRunId})
          FOR UPDATE
        `;
        for (const row of stale) {
          await transaction`
            UPDATE dataset_records SET removed=true WHERE id=${String(row.id)}
          `;
          await transaction`
            INSERT INTO record_changes(
              id,dataset_id,dataset_record_id,source_run_id,type,before,after,created_at
            ) VALUES (
              ${randomUUID()},${dataset.id},${String(row.id)},${input.sourceRunId},'removed',
              ${transaction.json(jsonValue(objectValue(row.data)))},NULL,${timestamp}
            )
          `;
          stats.removed += 1;
        }
      }

      const fingerprintRows = await transaction`
        SELECT record_key,content_hash,removed FROM dataset_records WHERE dataset_id=${dataset.id}
      `;
      stats.current = fingerprintRows.filter((row) => !Boolean(row.removed)).length;
      const updatedDatasets = await transaction`
        UPDATE datasets SET current_count=${stats.current},updated_at=${timestamp}
        WHERE id=${dataset.id} RETURNING *
      `;
      dataset = datasetRow(updatedDatasets[0] as PgRow);
      const fingerprint = datasetFingerprint(
        SCHEMA_VERSION,
        fingerprintRows.map((row) => ({
          recordKey: String(row.record_key),
          contentHash: String(row.content_hash),
          removed: Boolean(row.removed),
        })),
        input.settings,
      );
      const snapshotId = randomUUID();
      const snapshots = await transaction`
        INSERT INTO dataset_snapshots(
          id,dataset_id,source_run_id,fingerprint,schema_version,projection_settings,status,
          stats,row_count,parquet_artifact_id,manifest_artifact_id,warnings,created_at,updated_at
        ) VALUES (
          ${snapshotId},${dataset.id},${input.sourceRunId},${fingerprint},1,
          ${transaction.json(jsonValue(input.settings))},'projected',
          ${transaction.json(jsonValue(stats))},${stats.current},NULL,NULL,
          ${transaction.json(jsonValue([]))},${timestamp},${timestamp}
        ) RETURNING *
      `;
      await transaction`
        INSERT INTO platform_events(
          id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
        ) VALUES (
          ${randomUUID()},'dataset.projected',1,'datasets','dataset',${dataset.id},
          ${transaction.json(
            jsonValue({ sourceRunId: input.sourceRunId, snapshotId, ...stats }),
          )},${timestamp}
        )
      `;
      const snapshot = snapshotRow(snapshots[0] as PgRow);
      return { dataset, snapshot, stats, reused: false };
    });
  }

  async listDatasets(cursor?: string, limit = 100) {
    const pageSize = Math.min(Math.max(limit, 1), 500);
    const decoded = cursor ? decodeCursor(cursor) : null;
    const rows = decoded
      ? await this.sql`
          SELECT * FROM datasets
          WHERE updated_at<${new Date(decoded.at)}
            OR (updated_at=${new Date(decoded.at)} AND id<${decoded.id})
          ORDER BY updated_at DESC,id DESC LIMIT ${pageSize + 1}
        `
      : await this.sql`
          SELECT * FROM datasets ORDER BY updated_at DESC,id DESC LIMIT ${pageSize + 1}
        `;
    const items = rows.slice(0, pageSize).map((row) => datasetRow(row as PgRow));
    return {
      items,
      nextCursor:
        rows.length > pageSize ? encodeCursor(items.at(-1)!.updatedAt, items.at(-1)!.id) : null,
    };
  }

  async getDataset(id: string): Promise<Dataset | null> {
    const rows = await this.sql`SELECT * FROM datasets WHERE id=${id}`;
    return rows[0] ? datasetRow(rows[0] as PgRow) : null;
  }

  async getDatasetBySourceTask(sourceTaskId: string): Promise<Dataset | null> {
    const rows = await this.sql`SELECT * FROM datasets WHERE source_task_id=${sourceTaskId}`;
    return rows[0] ? datasetRow(rows[0] as PgRow) : null;
  }

  async listRecords(
    datasetId: string,
    cursor?: string,
    limit = 100,
    options: { includeRemoved?: boolean } = {},
  ): Promise<DatasetRecordPage> {
    const pageSize = Math.min(Math.max(limit, 1), 500);
    const decoded = cursor ? decodeCursor(cursor) : null;
    const rows = await this.sql`
      SELECT * FROM dataset_records
      WHERE dataset_id=${datasetId}
        AND (${Boolean(options.includeRemoved)} OR removed=false)
        AND (${!decoded} OR last_seen_at<${decoded ? new Date(decoded.at) : new Date(0)}
          OR (last_seen_at=${decoded ? new Date(decoded.at) : new Date(0)} AND id<${decoded?.id ?? ''}))
      ORDER BY last_seen_at DESC,id DESC LIMIT ${pageSize + 1}
    `;
    const items = rows.slice(0, pageSize).map((row) => datasetRecordRow(row as PgRow));
    const latest = await this.sql`
      SELECT stats FROM dataset_snapshots
      WHERE dataset_id=${datasetId} ORDER BY created_at DESC LIMIT 1
    `;
    return {
      items,
      nextCursor:
        rows.length > pageSize ? encodeCursor(items.at(-1)!.lastSeenAt, items.at(-1)!.id) : null,
      stats: latest[0] ? statsValue(latest[0].stats) : emptyStats(),
    };
  }

  async listChanges(
    datasetId: string,
    cursor?: string,
    limit = 100,
    sourceRunId?: string,
  ): Promise<RecordChangePage> {
    const pageSize = Math.min(Math.max(limit, 1), 500);
    const decoded = cursor ? decodeCursor(cursor) : null;
    const rows = await this.sql`
      SELECT * FROM record_changes
      WHERE dataset_id=${datasetId}
        AND (${!sourceRunId} OR source_run_id=${sourceRunId ?? ''})
        AND (${!decoded} OR created_at<${decoded ? new Date(decoded.at) : new Date(0)}
          OR (created_at=${decoded ? new Date(decoded.at) : new Date(0)} AND id<${decoded?.id ?? ''}))
      ORDER BY created_at DESC,id DESC LIMIT ${pageSize + 1}
    `;
    const items = rows.slice(0, pageSize).map((row) => recordChangeRow(row as PgRow));
    return {
      items,
      nextCursor:
        rows.length > pageSize ? encodeCursor(items.at(-1)!.createdAt, items.at(-1)!.id) : null,
    };
  }

  async listSnapshots(datasetId: string): Promise<DatasetSnapshot[]> {
    const rows = await this.sql`
      SELECT * FROM dataset_snapshots
      WHERE dataset_id=${datasetId} ORDER BY created_at DESC,id DESC
    `;
    return rows.map((row) => snapshotRow(row as PgRow));
  }

  async getSnapshot(id: string): Promise<DatasetSnapshot | null> {
    const rows = await this.sql`SELECT * FROM dataset_snapshots WHERE id=${id}`;
    return rows[0] ? snapshotRow(rows[0] as PgRow) : null;
  }

  async findSnapshotByFingerprint(
    datasetId: string,
    fingerprint: string,
  ): Promise<DatasetSnapshot | null> {
    const rows = await this.sql`
      SELECT * FROM dataset_snapshots
      WHERE dataset_id=${datasetId} AND fingerprint=${fingerprint}
      ORDER BY (status='ready') DESC,created_at DESC LIMIT 1
    `;
    return rows[0] ? snapshotRow(rows[0] as PgRow) : null;
  }
}

function datasetRow(row: PgRow): Dataset {
  return {
    id: String(row.id),
    sourceTaskId: String(row.source_task_id),
    settings: objectValue(row.settings) as unknown as Dataset['settings'],
    schemaVersion: Number(row.schema_version),
    currentCount: Number(row.current_count),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function datasetRecordRow(row: PgRow): DatasetRecord {
  return {
    id: String(row.id),
    datasetId: String(row.dataset_id),
    taskId: String(row.source_task_id),
    recordKey: String(row.record_key),
    sourceUrl: String(row.source_url),
    data: objectValue(row.data),
    contentHash: String(row.content_hash),
    removed: Boolean(row.removed),
    firstRunId: nullableString(row.first_run_id),
    lastRunId: nullableString(row.last_run_id),
    firstSeenAt: iso(row.first_seen_at),
    lastSeenAt: iso(row.last_seen_at),
  };
}

function recordChangeRow(row: PgRow): RecordChange {
  return {
    id: String(row.id),
    datasetId: String(row.dataset_id),
    datasetRecordId: String(row.dataset_record_id),
    runId: String(row.source_run_id),
    type: row.type as RecordChange['type'],
    before: row.before ? objectValue(row.before) : null,
    after: row.after ? objectValue(row.after) : null,
    createdAt: iso(row.created_at),
  };
}

function snapshotRow(row: PgRow): DatasetSnapshot {
  return {
    id: String(row.id),
    datasetId: String(row.dataset_id),
    sourceRunId: nullableString(row.source_run_id),
    fingerprint: String(row.fingerprint),
    schemaVersion: Number(row.schema_version),
    projectionSettings: objectValue(row.projection_settings),
    status: row.status as DatasetSnapshot['status'],
    stats: statsValue(row.stats),
    rowCount: Number(row.row_count),
    parquetArtifactId: nullableString(row.parquet_artifact_id),
    manifestArtifactId: nullableString(row.manifest_artifact_id),
    warnings: Array.isArray(row.warnings) ? row.warnings.map(String) : [],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function statsValue(value: unknown): DatasetStats {
  return objectValue(value) as unknown as DatasetStats;
}

function emptyStats(): DatasetStats {
  return { added: 0, updated: 0, removed: 0, unchanged: 0, current: 0 };
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify({ at, id })).toString('base64url');
}

function decodeCursor(cursor: string): { at: string; id: string } {
  const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as Record<string, unknown>;
  if (typeof parsed.at !== 'string' || typeof parsed.id !== 'string') {
    throw new Error('Invalid Dataset cursor');
  }
  return { at: parsed.at, id: parsed.id };
}

function jsonValue(value: unknown): Parameters<PostgresClient['json']>[0] {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Value is not JSON serializable');
  return JSON.parse(serialized) as Parameters<PostgresClient['json']>[0];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
