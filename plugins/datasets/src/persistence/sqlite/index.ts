import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { DatasetRecord, DatasetStats, RecordChange } from '@zhiyun/shared';
import type {
  Dataset,
  DatasetCommitInput,
  DatasetCommitResult,
  DatasetRecordPage,
  DatasetRepository,
  DatasetSnapshot,
  RecordChangePage,
  RunRecordPage,
  SnapshotMaterializationClaim,
} from '../../contracts/index.js';
import { datasetFingerprint, normalizeDatasetInputs } from '../../domain/index.js';
import { datasetsSqliteMigration001 } from '../../migrations/sqlite/index.js';

type SqlRow = Record<string, unknown>;
const MIGRATION_ID = '001-initial';
const SCHEMA_VERSION = 1;

export class SqliteDatasetRepository implements DatasetRepository {
  private readonly sqlite: Database.Database;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.sqlite = new Database(filePath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
  }

  async migrate(): Promise<void> {
    const checksum = sha256(datasetsSqliteMigration001);
    const existing = this.sqlite
      .prepare('SELECT checksum FROM plugin_migrations WHERE plugin_id=? AND migration_id=?')
      .get('datasets', MIGRATION_ID) as SqlRow | undefined;
    if (existing) {
      if (existing.checksum !== checksum) {
        throw new Error('Migration checksum mismatch for datasets:001-initial');
      }
      return;
    }
    const started = performance.now();
    this.sqlite.transaction(() => {
      this.sqlite.exec(datasetsSqliteMigration001);
      this.sqlite
        .prepare(
          `INSERT INTO plugin_migrations(
             plugin_id,migration_id,plugin_version,checksum,executed_at,duration_ms,result
           ) VALUES ('datasets',?,'1.0.0',?,?,?,'succeeded')`,
        )
        .run(
          MIGRATION_ID,
          checksum,
          new Date().toISOString(),
          Math.max(0, Math.round(performance.now() - started)),
        );
    })();
  }

  async close(): Promise<void> {
    if (this.sqlite.open) this.sqlite.close();
  }

  async commitRunRecords(input: DatasetCommitInput): Promise<DatasetCommitResult> {
    return this.sqlite.transaction(() => {
      const existingSnapshot = this.sqlite
        .prepare('SELECT * FROM dataset_snapshots WHERE source_run_id=?')
        .get(input.sourceRunId) as SqlRow | undefined;
      if (existingSnapshot) {
        const dataset = this.sqlite
          .prepare('SELECT * FROM datasets WHERE id=?')
          .get(existingSnapshot.dataset_id) as SqlRow;
        const snapshot = snapshotRow(existingSnapshot);
        return { dataset: datasetRow(dataset), snapshot, stats: snapshot.stats, reused: true };
      }

      const timestamp = new Date().toISOString();
      let storedDataset = this.sqlite
        .prepare('SELECT * FROM datasets WHERE source_task_id=?')
        .get(input.sourceTaskId) as SqlRow | undefined;
      if (!storedDataset) {
        const id = randomUUID();
        this.sqlite
          .prepare(
            `INSERT INTO datasets(
               id,source_task_id,settings,schema_version,current_count,created_at,updated_at
             ) VALUES (?,?,?,1,0,?,?)`,
          )
          .run(id, input.sourceTaskId, JSON.stringify(input.settings), timestamp, timestamp);
        storedDataset = this.sqlite.prepare('SELECT * FROM datasets WHERE id=?').get(id) as SqlRow;
      } else {
        this.sqlite
          .prepare('UPDATE datasets SET settings=?,updated_at=? WHERE id=?')
          .run(JSON.stringify(input.settings), timestamp, storedDataset.id);
      }
      const datasetId = String(storedDataset.id);
      const normalized = normalizeDatasetInputs(input.sourceRunId, input.settings, input.records);
      const stats: DatasetStats = {
        added: 0,
        updated: 0,
        removed: 0,
        unchanged: 0,
        current: 0,
      };
      const insertRaw = this.sqlite.prepare(
        `INSERT OR IGNORE INTO records(
           id,dataset_id,source_run_id,record_key,source_url,data,content_hash,created_at
         ) VALUES (?,?,?,?,?,?,?,?)`,
      );
      for (const record of normalized) {
        insertRaw.run(
          randomUUID(),
          datasetId,
          input.sourceRunId,
          record.recordKey,
          record.sourceUrl,
          JSON.stringify(record.data),
          record.contentHash,
          timestamp,
        );
        const existing = this.sqlite
          .prepare('SELECT * FROM dataset_records WHERE dataset_id=? AND record_key=?')
          .get(datasetId, record.recordKey) as SqlRow | undefined;
        if (!existing) {
          const id = randomUUID();
          this.sqlite
            .prepare(
              `INSERT INTO dataset_records(
                 id,dataset_id,source_task_id,record_key,source_url,data,content_hash,removed,
                 first_run_id,last_run_id,first_seen_at,last_seen_at
               ) VALUES (?,?,?,?,?,?,?,0,?,?,?,?)`,
            )
            .run(
              id,
              datasetId,
              input.sourceTaskId,
              record.recordKey,
              record.sourceUrl,
              JSON.stringify(record.data),
              record.contentHash,
              input.sourceRunId,
              input.sourceRunId,
              timestamp,
              timestamp,
            );
          insertChange(
            this.sqlite,
            datasetId,
            id,
            input.sourceRunId,
            'added',
            null,
            record.data,
            timestamp,
          );
          stats.added += 1;
        } else if (
          String(existing.content_hash) !== record.contentHash ||
          Boolean(existing.removed)
        ) {
          const before = parseObject(existing.data);
          this.sqlite
            .prepare(
              `UPDATE dataset_records SET
                 source_url=?,data=?,content_hash=?,removed=0,last_run_id=?,last_seen_at=?
               WHERE id=?`,
            )
            .run(
              record.sourceUrl,
              JSON.stringify(record.data),
              record.contentHash,
              input.sourceRunId,
              timestamp,
              existing.id,
            );
          insertChange(
            this.sqlite,
            datasetId,
            String(existing.id),
            input.sourceRunId,
            'updated',
            before,
            record.data,
            timestamp,
          );
          stats.updated += 1;
        } else {
          this.sqlite
            .prepare('UPDATE dataset_records SET removed=0,last_run_id=?,last_seen_at=? WHERE id=?')
            .run(input.sourceRunId, timestamp, existing.id);
          stats.unchanged += 1;
        }
      }

      if (input.settings.mode === 'snapshot' && input.settings.detectRemoved) {
        const stale = this.sqlite
          .prepare(
            `SELECT * FROM dataset_records
             WHERE dataset_id=? AND removed=0 AND (last_run_id IS NULL OR last_run_id<>?)`,
          )
          .all(datasetId, input.sourceRunId) as SqlRow[];
        for (const row of stale) {
          this.sqlite.prepare('UPDATE dataset_records SET removed=1 WHERE id=?').run(row.id);
          insertChange(
            this.sqlite,
            datasetId,
            String(row.id),
            input.sourceRunId,
            'removed',
            parseObject(row.data),
            null,
            timestamp,
          );
          stats.removed += 1;
        }
      }

      const fingerprintRows = this.sqlite
        .prepare('SELECT record_key,content_hash,removed FROM dataset_records WHERE dataset_id=?')
        .all(datasetId) as SqlRow[];
      stats.current = fingerprintRows.filter((row) => !row.removed).length;
      this.sqlite
        .prepare('UPDATE datasets SET current_count=?,updated_at=? WHERE id=?')
        .run(stats.current, timestamp, datasetId);
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
      this.sqlite
        .prepare(
          `INSERT INTO dataset_snapshots(
             id,dataset_id,source_run_id,fingerprint,schema_version,projection_settings,status,
             stats,row_count,parquet_artifact_id,manifest_artifact_id,warnings,created_at,updated_at
           ) VALUES (?,?,?,?,1,?,'projected',?,?,NULL,NULL,'[]',?,?)`,
        )
        .run(
          snapshotId,
          datasetId,
          input.sourceRunId,
          fingerprint,
          JSON.stringify(input.settings),
          JSON.stringify(stats),
          stats.current,
          timestamp,
          timestamp,
        );
      appendEvent(this.sqlite, 'dataset.projected', datasetId, {
        sourceRunId: input.sourceRunId,
        snapshotId,
        ...stats,
      });
      const dataset = datasetRow(
        this.sqlite.prepare('SELECT * FROM datasets WHERE id=?').get(datasetId) as SqlRow,
      );
      const snapshot = snapshotRow(
        this.sqlite.prepare('SELECT * FROM dataset_snapshots WHERE id=?').get(snapshotId) as SqlRow,
      );
      return { dataset, snapshot, stats, reused: false };
    })();
  }

  async listDatasets(cursor?: string, limit = 100) {
    const pageSize = Math.min(Math.max(limit, 1), 500);
    const decoded = cursor ? decodeCursor(cursor) : null;
    const rows = decoded
      ? (this.sqlite
          .prepare(
            `SELECT * FROM datasets WHERE updated_at<? OR (updated_at=? AND id<?)
             ORDER BY updated_at DESC,id DESC LIMIT ?`,
          )
          .all(decoded.at, decoded.at, decoded.id, pageSize + 1) as SqlRow[])
      : (this.sqlite
          .prepare('SELECT * FROM datasets ORDER BY updated_at DESC,id DESC LIMIT ?')
          .all(pageSize + 1) as SqlRow[]);
    const items = rows.slice(0, pageSize).map(datasetRow);
    return {
      items,
      nextCursor:
        rows.length > pageSize ? encodeCursor(items.at(-1)!.updatedAt, items.at(-1)!.id) : null,
    };
  }

  async getDataset(id: string): Promise<Dataset | null> {
    const row = this.sqlite.prepare('SELECT * FROM datasets WHERE id=?').get(id) as
      SqlRow | undefined;
    return row ? datasetRow(row) : null;
  }

  async getDatasetBySourceTask(sourceTaskId: string): Promise<Dataset | null> {
    const row = this.sqlite
      .prepare('SELECT * FROM datasets WHERE source_task_id=?')
      .get(sourceTaskId) as SqlRow | undefined;
    return row ? datasetRow(row) : null;
  }

  async listRecords(
    datasetId: string,
    cursor?: string,
    limit = 100,
    options: {
      includeRemoved?: boolean;
      filter?: Record<string, string | number | boolean | null>;
    } = {},
  ): Promise<DatasetRecordPage> {
    const pageSize = Math.min(Math.max(limit, 1), 500);
    const decoded = cursor ? decodeCursor(cursor) : null;
    const clauses = ['dataset_id=?'];
    const parameters: unknown[] = [datasetId];
    if (!options.includeRemoved) clauses.push('removed=0');
    for (const [field, value] of Object.entries(options.filter ?? {})) {
      const path = `$."${field}"`;
      if (value === null) {
        clauses.push("json_type(data,?)='null'");
        parameters.push(path);
      } else {
        clauses.push('json_extract(data,?)=?');
        parameters.push(path, typeof value === 'boolean' ? Number(value) : value);
      }
    }
    if (decoded) {
      clauses.push('(last_seen_at<? OR (last_seen_at=? AND id<?))');
      parameters.push(decoded.at, decoded.at, decoded.id);
    }
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM dataset_records WHERE ${clauses.join(' AND ')}
         ORDER BY last_seen_at DESC,id DESC LIMIT ?`,
      )
      .all(...parameters, pageSize + 1) as SqlRow[];
    const items = rows.slice(0, pageSize).map(datasetRecordRow);
    const latest = this.sqlite
      .prepare(
        'SELECT stats FROM dataset_snapshots WHERE dataset_id=? ORDER BY created_at DESC LIMIT 1',
      )
      .get(datasetId) as SqlRow | undefined;
    return {
      items,
      nextCursor:
        rows.length > pageSize ? encodeCursor(items.at(-1)!.lastSeenAt, items.at(-1)!.id) : null,
      stats: latest ? parseStats(latest.stats) : emptyStats(),
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
    const clauses = ['dataset_id=?'];
    const parameters: unknown[] = [datasetId];
    if (sourceRunId) {
      clauses.push('source_run_id=?');
      parameters.push(sourceRunId);
    }
    if (decoded) {
      clauses.push('(created_at<? OR (created_at=? AND id<?))');
      parameters.push(decoded.at, decoded.at, decoded.id);
    }
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM record_changes WHERE ${clauses.join(' AND ')}
         ORDER BY created_at DESC,id DESC LIMIT ?`,
      )
      .all(...parameters, pageSize + 1) as SqlRow[];
    const items = rows.slice(0, pageSize).map(recordChangeRow);
    return {
      items,
      nextCursor:
        rows.length > pageSize ? encodeCursor(items.at(-1)!.createdAt, items.at(-1)!.id) : null,
    };
  }

  async listRunRecords(runId: string, cursor?: string, limit = 100): Promise<RunRecordPage> {
    const pageSize = Math.min(Math.max(limit, 1), 500);
    const decoded = cursor ? decodeCursor(cursor) : null;
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM records
         WHERE source_run_id=?
           AND (? IS NULL OR created_at<? OR (created_at=? AND id<?))
         ORDER BY created_at DESC,id DESC LIMIT ?`,
      )
      .all(
        runId,
        decoded?.at ?? null,
        decoded?.at ?? '',
        decoded?.at ?? '',
        decoded?.id ?? '',
        pageSize + 1,
      ) as SqlRow[];
    const items = rows.slice(0, pageSize).map((row) => ({
      id: String(row.id),
      runId: String(row.source_run_id),
      sourceUrl: String(row.source_url),
      data: parseObject(row.data),
      createdAt: String(row.created_at),
    }));
    return {
      items,
      nextCursor:
        rows.length > pageSize ? encodeCursor(items.at(-1)!.createdAt, items.at(-1)!.id) : null,
    };
  }

  async listSnapshots(datasetId: string): Promise<DatasetSnapshot[]> {
    return (
      this.sqlite
        .prepare(
          'SELECT * FROM dataset_snapshots WHERE dataset_id=? ORDER BY created_at DESC,id DESC',
        )
        .all(datasetId) as SqlRow[]
    ).map(snapshotRow);
  }

  async getSnapshot(id: string): Promise<DatasetSnapshot | null> {
    const row = this.sqlite.prepare('SELECT * FROM dataset_snapshots WHERE id=?').get(id) as
      SqlRow | undefined;
    return row ? snapshotRow(row) : null;
  }

  async findSnapshotByFingerprint(
    datasetId: string,
    fingerprint: string,
  ): Promise<DatasetSnapshot | null> {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM dataset_snapshots
         WHERE dataset_id=? AND fingerprint=? ORDER BY status='ready' DESC,created_at DESC LIMIT 1`,
      )
      .get(datasetId, fingerprint) as SqlRow | undefined;
    return row ? snapshotRow(row) : null;
  }

  async withConsistentSnapshotRead<T>(
    datasetId: string,
    consume: (read: {
      dataset: Dataset;
      records: AsyncIterable<{
        recordKey: string;
        sourceUrl: string;
        data: Record<string, unknown>;
        contentHash: string;
        removed: boolean;
      }>;
    }) => Promise<T>,
  ): Promise<T> {
    if (this.filePath === ':memory:') {
      throw new Error('Consistent Snapshot streaming requires a file-backed SQLite database');
    }
    const reader = new Database(this.filePath, { readonly: true, fileMustExist: true });
    reader.pragma('query_only = ON');
    reader.exec('BEGIN');
    try {
      const dataset = reader.prepare('SELECT * FROM datasets WHERE id=?').get(datasetId) as
        SqlRow | undefined;
      if (!dataset) throw new Error(`Dataset not found: ${datasetId}`);
      const statement = reader.prepare(
        `SELECT record_key,source_url,data,content_hash,removed
         FROM dataset_records WHERE dataset_id=? ORDER BY record_key ASC`,
      );
      const records = async function* () {
        for (const row of statement.iterate(datasetId) as Iterable<SqlRow>) {
          yield {
            recordKey: String(row.record_key),
            sourceUrl: String(row.source_url),
            data: parseObject(row.data),
            contentHash: String(row.content_hash),
            removed: Boolean(row.removed),
          };
        }
      };
      return await consume({ dataset: datasetRow(dataset), records: records() });
    } finally {
      reader.exec('ROLLBACK');
      reader.close();
    }
  }

  async claimSnapshotMaterialization(
    datasetId: string,
    fingerprint: string,
  ): Promise<SnapshotMaterializationClaim> {
    return this.sqlite.transaction(() => {
      const rows = this.sqlite
        .prepare(
          `SELECT * FROM dataset_snapshots
           WHERE dataset_id=? AND fingerprint=?
           ORDER BY status='ready' DESC,status='preparing' DESC,created_at DESC,id DESC`,
        )
        .all(datasetId, fingerprint) as SqlRow[];
      const selected = rows[0];
      if (!selected) throw new Error('Projected Dataset Snapshot was not found for fingerprint');
      const snapshot = snapshotRow(selected);
      if (snapshot.status === 'ready') return { snapshot, claimed: false, reused: true };
      if (snapshot.status === 'preparing') return { snapshot, claimed: false, reused: false };
      const timestamp = new Date().toISOString();
      const updated = this.sqlite
        .prepare(
          `UPDATE dataset_snapshots SET status='preparing',warnings='[]',updated_at=?
           WHERE id=? AND status IN ('projected','failed') RETURNING *`,
        )
        .get(timestamp, snapshot.id) as SqlRow | undefined;
      if (!updated) {
        const current = this.sqlite
          .prepare('SELECT * FROM dataset_snapshots WHERE id=?')
          .get(snapshot.id) as SqlRow;
        return { snapshot: snapshotRow(current), claimed: false, reused: false };
      }
      return { snapshot: snapshotRow(updated), claimed: true, reused: false };
    })();
  }

  async completeSnapshotMaterialization(input: {
    snapshotId: string;
    parquetArtifactId: string;
    manifestArtifactId: string;
    rowCount: number;
    warnings: string[];
  }): Promise<DatasetSnapshot> {
    return this.sqlite.transaction(() => {
      const timestamp = new Date().toISOString();
      const updated = this.sqlite
        .prepare(
          `UPDATE dataset_snapshots SET
             status='ready',parquet_artifact_id=?,manifest_artifact_id=?,row_count=?,warnings=?,
             updated_at=?
           WHERE id=? AND status='preparing' RETURNING *`,
        )
        .get(
          input.parquetArtifactId,
          input.manifestArtifactId,
          input.rowCount,
          JSON.stringify(input.warnings),
          timestamp,
          input.snapshotId,
        ) as SqlRow | undefined;
      if (!updated) throw new Error('Dataset Snapshot is not in preparing state');
      const snapshot = snapshotRow(updated);
      appendEvent(this.sqlite, 'dataset.snapshot.ready', snapshot.datasetId, {
        snapshotId: snapshot.id,
        fingerprint: snapshot.fingerprint,
        rowCount: snapshot.rowCount,
      });
      return snapshot;
    })();
  }

  async failSnapshotMaterialization(snapshotId: string, warning: string): Promise<DatasetSnapshot> {
    const updated = this.sqlite
      .prepare(
        `UPDATE dataset_snapshots SET status='failed',warnings=?,updated_at=?
         WHERE id=? AND status='preparing' RETURNING *`,
      )
      .get(JSON.stringify([warning.slice(0, 4_000)]), new Date().toISOString(), snapshotId) as
      SqlRow | undefined;
    if (!updated) throw new Error('Dataset Snapshot is not in preparing state');
    return snapshotRow(updated);
  }
}

function insertChange(
  sqlite: Database.Database,
  datasetId: string,
  datasetRecordId: string,
  sourceRunId: string,
  type: RecordChange['type'],
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  createdAt: string,
): void {
  sqlite
    .prepare(
      `INSERT INTO record_changes(
         id,dataset_id,dataset_record_id,source_run_id,type,before,after,created_at
       ) VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(
      randomUUID(),
      datasetId,
      datasetRecordId,
      sourceRunId,
      type,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      createdAt,
    );
}

function appendEvent(
  sqlite: Database.Database,
  type: string,
  aggregateId: string,
  payload: Record<string, unknown>,
): void {
  sqlite
    .prepare(
      `INSERT INTO platform_events(
         id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
       ) VALUES (?,?,1,'datasets','dataset',?,?,?)`,
    )
    .run(randomUUID(), type, aggregateId, JSON.stringify(payload), new Date().toISOString());
}

function datasetRow(row: SqlRow): Dataset {
  return {
    id: String(row.id),
    sourceTaskId: String(row.source_task_id),
    settings: JSON.parse(String(row.settings)) as Dataset['settings'],
    schemaVersion: Number(row.schema_version),
    currentCount: Number(row.current_count),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function datasetRecordRow(row: SqlRow): DatasetRecord {
  return {
    id: String(row.id),
    datasetId: String(row.dataset_id),
    taskId: String(row.source_task_id),
    recordKey: String(row.record_key),
    sourceUrl: String(row.source_url),
    data: parseObject(row.data),
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
    runId: String(row.source_run_id),
    type: row.type as RecordChange['type'],
    before: row.before ? parseObject(row.before) : null,
    after: row.after ? parseObject(row.after) : null,
    createdAt: String(row.created_at),
  };
}

function snapshotRow(row: SqlRow): DatasetSnapshot {
  return {
    id: String(row.id),
    datasetId: String(row.dataset_id),
    sourceRunId: row.source_run_id ? String(row.source_run_id) : null,
    fingerprint: String(row.fingerprint),
    schemaVersion: Number(row.schema_version),
    projectionSettings: parseObject(row.projection_settings),
    status: row.status as DatasetSnapshot['status'],
    stats: parseStats(row.stats),
    rowCount: Number(row.row_count),
    parquetArtifactId: row.parquet_artifact_id ? String(row.parquet_artifact_id) : null,
    manifestArtifactId: row.manifest_artifact_id ? String(row.manifest_artifact_id) : null,
    warnings: JSON.parse(String(row.warnings)) as string[],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseObject(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function parseStats(value: unknown): DatasetStats {
  return parseObject(value) as unknown as DatasetStats;
}

function emptyStats(): DatasetStats {
  return { added: 0, updated: 0, removed: 0, unchanged: 0, current: 0 };
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
