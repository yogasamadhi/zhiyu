import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { preferenceContentSchema, type PreferenceSignal } from '@zhiyun/shared';
import type {
  PreferenceSignalPage,
  PreferencesRepository,
  TrendSourceBinding,
} from '../../contracts/index.js';
import { preferencesPostgresMigration001 } from '../../migrations/postgres/index.js';

type PgRow = Record<string, unknown>;
type PostgresClient = ReturnType<typeof postgres>;
const MIGRATION_ID = '001-initial';

export class PostgresPreferencesRepository implements PreferencesRepository {
  private readonly sql: PostgresClient;

  constructor(connectionString: string, maxConnections = 5) {
    this.sql = postgres(connectionString, { max: maxConnections });
  }

  async migrate(): Promise<void> {
    const checksum = sha256(preferencesPostgresMigration001);
    const rows = await this.sql`
      SELECT checksum FROM plugin_migrations
      WHERE plugin_id='preferences' AND migration_id=${MIGRATION_ID}
    `;
    if (rows[0]) {
      if (rows[0].checksum !== checksum) {
        throw new Error('Migration checksum mismatch for preferences:001-initial');
      }
      return;
    }
    const started = performance.now();
    await this.sql.begin(async (transaction) => {
      await transaction.unsafe(preferencesPostgresMigration001);
      await transaction`
        INSERT INTO plugin_migrations(
          plugin_id,migration_id,plugin_version,checksum,executed_at,duration_ms,result
        ) VALUES (
          'preferences',${MIGRATION_ID},'1.0.0',${checksum},${new Date()},
          ${Math.max(0, Math.round(performance.now() - started))},'succeeded'
        )
      `;
    });
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  async listTrendSourceBindings(): Promise<TrendSourceBinding[]> {
    const rows = await this.sql`SELECT * FROM trend_sources ORDER BY key`;
    return rows.map((row) => trendSourceRow(row as PgRow));
  }

  async getTrendSourceBinding(key: string): Promise<TrendSourceBinding | null> {
    const rows = await this.sql`SELECT * FROM trend_sources WHERE key=${key}`;
    return rows[0] ? trendSourceRow(rows[0] as PgRow) : null;
  }

  async upsertTrendSourceBinding(
    input: Pick<TrendSourceBinding, 'key' | 'platform' | 'taskId' | 'enabled' | 'autoRefresh'>,
  ): Promise<TrendSourceBinding> {
    return this.sql.begin(async (transaction) => {
      const timestamp = new Date();
      const rows = await transaction`
        INSERT INTO trend_sources(
          key,platform,task_id,enabled,auto_refresh,created_at,updated_at
        ) VALUES (
          ${input.key},${input.platform},${input.taskId},${input.enabled},${input.autoRefresh},
          ${timestamp},${timestamp}
        )
        ON CONFLICT(key) DO UPDATE SET
          platform=EXCLUDED.platform,task_id=EXCLUDED.task_id,enabled=EXCLUDED.enabled,
          auto_refresh=EXCLUDED.auto_refresh,updated_at=EXCLUDED.updated_at
        RETURNING *
      `;
      await transaction`
        INSERT INTO platform_events(
          id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
        ) VALUES (
          ${randomUUID()},'preferences.trend-source.updated',1,'preferences','trend-source',
          ${input.key},${transaction.json(jsonValue({ taskId: input.taskId }))},${timestamp}
        )
      `;
      return trendSourceRow(rows[0] as PgRow);
    });
  }

  async updateTrendSourceBinding(
    key: string,
    input: Partial<Pick<TrendSourceBinding, 'taskId' | 'enabled' | 'autoRefresh'>>,
  ): Promise<TrendSourceBinding | null> {
    return this.sql.begin(async (transaction) => {
      const selected = await transaction`SELECT * FROM trend_sources WHERE key=${key} FOR UPDATE`;
      const current = selected[0] as PgRow | undefined;
      if (!current) return null;
      const timestamp = new Date();
      const taskId =
        input.taskId === undefined
          ? current.task_id === null || current.task_id === undefined
            ? null
            : String(current.task_id)
          : input.taskId;
      const enabled = input.enabled === undefined ? Boolean(current.enabled) : input.enabled;
      const autoRefresh =
        input.autoRefresh === undefined ? Boolean(current.auto_refresh) : input.autoRefresh;
      const rows = await transaction`
        UPDATE trend_sources SET
          task_id=${taskId},enabled=${enabled},auto_refresh=${autoRefresh},
          updated_at=${timestamp}
        WHERE key=${key} RETURNING *
      `;
      await transaction`
        INSERT INTO platform_events(
          id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
        ) VALUES (
          ${randomUUID()},'preferences.trend-source.updated',1,'preferences','trend-source',
          ${key},${transaction.json(jsonValue({}))},${timestamp}
        )
      `;
      return trendSourceRow(rows[0] as PgRow);
    });
  }

  async clearTaskReference(taskId: string): Promise<number> {
    return this.sql.begin(async (transaction) => {
      const timestamp = new Date();
      const rows = await transaction`
        UPDATE trend_sources SET task_id=NULL,updated_at=${timestamp}
        WHERE task_id=${taskId} RETURNING key
      `;
      if (rows.length > 0) {
        await transaction`
          INSERT INTO platform_events(
            id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
          ) VALUES (
            ${randomUUID()},'preferences.trend-source.updated',1,'preferences','collection-task',
            ${taskId},${transaction.json(
              jsonValue({ taskReferenceCleared: true, affected: rows.length }),
            )},${timestamp}
          )
        `;
      }
      return rows.length;
    });
  }

  async listPreferenceSignals(cursor?: string, limit = 100): Promise<PreferenceSignalPage> {
    const pageSize = Math.min(Math.max(limit, 1), 500);
    const decoded = cursor ? decodeCursor(cursor) : null;
    const rows = decoded
      ? await this.sql`
          SELECT * FROM preference_signals
          WHERE updated_at<${new Date(decoded.updatedAt)}
            OR (updated_at=${new Date(decoded.updatedAt)} AND id<${decoded.id})
          ORDER BY updated_at DESC,id DESC LIMIT ${pageSize + 1}
        `
      : await this.sql`
          SELECT * FROM preference_signals
          ORDER BY updated_at DESC,id DESC LIMIT ${pageSize + 1}
        `;
    const items = rows.slice(0, pageSize).map((row) => preferenceSignalRow(row as PgRow));
    return {
      items,
      nextCursor: rows.length > pageSize ? encodeCursor(items.at(-1)!) : null,
    };
  }

  async upsertPreferenceSignal(
    input: Parameters<PreferencesRepository['upsertPreferenceSignal']>[0],
  ): Promise<PreferenceSignal> {
    return this.sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${input.targetKey},0))`;
      if (input.kind === 'like' || input.kind === 'dislike') {
        await transaction`
          DELETE FROM preference_signals
          WHERE target_key=${input.targetKey}
            AND kind=${input.kind === 'like' ? 'dislike' : 'like'}
        `;
      }
      const timestamp = new Date();
      const rows = await transaction`
        INSERT INTO preference_signals(
          id,target_key,kind,platform,content_type,external_id,title,content,created_at,updated_at
        ) VALUES (
          ${randomUUID()},${input.targetKey},${input.kind},${input.content.platform},
          ${input.content.contentType},${input.content.externalId},${input.content.title},
          ${transaction.json(jsonValue(input.content))},${timestamp},${timestamp}
        )
        ON CONFLICT(target_key,kind) DO UPDATE SET
          platform=EXCLUDED.platform,content_type=EXCLUDED.content_type,
          external_id=EXCLUDED.external_id,title=EXCLUDED.title,content=EXCLUDED.content,
          updated_at=EXCLUDED.updated_at
        RETURNING *
      `;
      const signal = preferenceSignalRow(rows[0] as PgRow);
      await transaction`
        INSERT INTO platform_events(
          id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
        ) VALUES (
          ${randomUUID()},'preferences.signal.updated',1,'preferences','preference-signal',
          ${signal.id},${transaction.json(
            jsonValue({ targetKey: input.targetKey, kind: input.kind }),
          )},${timestamp}
        )
      `;
      return signal;
    });
  }

  async deletePreferenceSignal(id: string): Promise<boolean> {
    return this.sql.begin(async (transaction) => {
      const rows = await transaction`DELETE FROM preference_signals WHERE id=${id} RETURNING id`;
      if (rows.length === 0) return false;
      await transaction`
        INSERT INTO platform_events(
          id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
        ) VALUES (
          ${randomUUID()},'preferences.signal.updated',1,'preferences','preference-signal',
          ${id},${transaction.json(jsonValue({ deleted: true }))},${new Date()}
        )
      `;
      return true;
    });
  }

  async clearPreferenceSignals(): Promise<number> {
    return this.sql.begin(async (transaction) => {
      const rows = await transaction`DELETE FROM preference_signals RETURNING id`;
      if (rows.length > 0) {
        await transaction`
          INSERT INTO platform_events(
            id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
          ) VALUES (
            ${randomUUID()},'preferences.signal.updated',1,'preferences','preference-signals',
            'all',${transaction.json(jsonValue({ cleared: rows.length }))},${new Date()}
          )
        `;
      }
      return rows.length;
    });
  }
}

function trendSourceRow(row: PgRow): TrendSourceBinding {
  return {
    key: String(row.key),
    platform: row.platform as TrendSourceBinding['platform'],
    taskId: row.task_id ? String(row.task_id) : null,
    enabled: Boolean(row.enabled),
    autoRefresh: Boolean(row.auto_refresh),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function preferenceSignalRow(row: PgRow): PreferenceSignal {
  return {
    id: String(row.id),
    targetKey: String(row.target_key),
    kind: row.kind as PreferenceSignal['kind'],
    content: preferenceContentSchema.parse(row.content),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function encodeCursor(signal: PreferenceSignal): string {
  return Buffer.from(JSON.stringify({ updatedAt: signal.updatedAt, id: signal.id })).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): { updatedAt: string; id: string } {
  const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as Record<string, unknown>;
  if (typeof parsed.updatedAt !== 'string' || typeof parsed.id !== 'string') {
    throw new Error('Invalid preference signal cursor');
  }
  return { updatedAt: parsed.updatedAt, id: parsed.id };
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function jsonValue(value: unknown): Parameters<PostgresClient['json']>[0] {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Value is not JSON serializable');
  return JSON.parse(serialized) as Parameters<PostgresClient['json']>[0];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
