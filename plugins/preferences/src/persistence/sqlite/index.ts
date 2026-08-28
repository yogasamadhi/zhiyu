import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { preferenceContentSchema, type PreferenceSignal } from '@zhiyun/shared';
import type {
  PreferenceSignalPage,
  PreferencesRepository,
  TrendSourceBinding,
} from '../../contracts/index.js';
import { preferencesSqliteMigration001 } from '../../migrations/sqlite/index.js';

type SqlRow = Record<string, unknown>;
const MIGRATION_ID = '001-initial';

export class SqlitePreferencesRepository implements PreferencesRepository {
  private readonly sqlite: Database.Database;

  constructor(filePath: string) {
    this.sqlite = new Database(filePath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
  }

  async migrate(): Promise<void> {
    const checksum = sha256(preferencesSqliteMigration001);
    const existing = this.sqlite
      .prepare('SELECT checksum FROM plugin_migrations WHERE plugin_id=? AND migration_id=?')
      .get('preferences', MIGRATION_ID) as SqlRow | undefined;
    if (existing) {
      if (existing.checksum !== checksum) {
        throw new Error('Migration checksum mismatch for preferences:001-initial');
      }
      return;
    }
    const started = performance.now();
    this.sqlite.transaction(() => {
      this.sqlite.exec(preferencesSqliteMigration001);
      this.sqlite
        .prepare(
          `INSERT INTO plugin_migrations(
             plugin_id,migration_id,plugin_version,checksum,executed_at,duration_ms,result
           ) VALUES ('preferences',?,'1.0.0',?,?,?,'succeeded')`,
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

  async listTrendSourceBindings(): Promise<TrendSourceBinding[]> {
    return (this.sqlite.prepare('SELECT * FROM trend_sources ORDER BY key').all() as SqlRow[]).map(
      trendSourceRow,
    );
  }

  async getTrendSourceBinding(key: string): Promise<TrendSourceBinding | null> {
    const row = this.sqlite.prepare('SELECT * FROM trend_sources WHERE key=?').get(key) as
      SqlRow | undefined;
    return row ? trendSourceRow(row) : null;
  }

  async upsertTrendSourceBinding(
    input: Pick<TrendSourceBinding, 'key' | 'platform' | 'taskId' | 'enabled' | 'autoRefresh'>,
  ): Promise<TrendSourceBinding> {
    const timestamp = new Date().toISOString();
    return this.sqlite.transaction(() => {
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
      appendEvent(this.sqlite, {
        type: 'preferences.trend-source.updated',
        aggregateType: 'trend-source',
        aggregateId: input.key,
        payload: { taskId: input.taskId },
        occurredAt: timestamp,
      });
      return trendSourceRow(
        this.sqlite.prepare('SELECT * FROM trend_sources WHERE key=?').get(input.key) as SqlRow,
      );
    })();
  }

  async updateTrendSourceBinding(
    key: string,
    input: Partial<Pick<TrendSourceBinding, 'taskId' | 'enabled' | 'autoRefresh'>>,
  ): Promise<TrendSourceBinding | null> {
    return this.sqlite.transaction(() => {
      const current = this.sqlite.prepare('SELECT * FROM trend_sources WHERE key=?').get(key) as
        SqlRow | undefined;
      if (!current) return null;
      const timestamp = new Date().toISOString();
      this.sqlite
        .prepare(
          'UPDATE trend_sources SET task_id=?,enabled=?,auto_refresh=?,updated_at=? WHERE key=?',
        )
        .run(
          input.taskId === undefined ? current.task_id : input.taskId,
          input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0,
          input.autoRefresh === undefined ? current.auto_refresh : input.autoRefresh ? 1 : 0,
          timestamp,
          key,
        );
      appendEvent(this.sqlite, {
        type: 'preferences.trend-source.updated',
        aggregateType: 'trend-source',
        aggregateId: key,
        payload: {},
        occurredAt: timestamp,
      });
      return trendSourceRow(
        this.sqlite.prepare('SELECT * FROM trend_sources WHERE key=?').get(key) as SqlRow,
      );
    })();
  }

  async clearTaskReference(taskId: string): Promise<number> {
    const timestamp = new Date().toISOString();
    return this.sqlite.transaction(() => {
      const result = this.sqlite
        .prepare('UPDATE trend_sources SET task_id=NULL,updated_at=? WHERE task_id=?')
        .run(timestamp, taskId);
      if (result.changes > 0) {
        appendEvent(this.sqlite, {
          type: 'preferences.trend-source.updated',
          aggregateType: 'collection-task',
          aggregateId: taskId,
          payload: { taskReferenceCleared: true, affected: result.changes },
          occurredAt: timestamp,
        });
      }
      return result.changes;
    })();
  }

  async listPreferenceSignals(cursor?: string, limit = 100): Promise<PreferenceSignalPage> {
    const pageSize = Math.min(Math.max(limit, 1), 500);
    const decoded = cursor ? decodeCursor(cursor) : null;
    const rows = decoded
      ? (this.sqlite
          .prepare(
            `SELECT * FROM preference_signals
             WHERE updated_at<? OR (updated_at=? AND id<?)
             ORDER BY updated_at DESC,id DESC LIMIT ?`,
          )
          .all(decoded.updatedAt, decoded.updatedAt, decoded.id, pageSize + 1) as SqlRow[])
      : (this.sqlite
          .prepare('SELECT * FROM preference_signals ORDER BY updated_at DESC,id DESC LIMIT ?')
          .all(pageSize + 1) as SqlRow[]);
    const items = rows.slice(0, pageSize).map(preferenceSignalRow);
    return {
      items,
      nextCursor: rows.length > pageSize ? encodeCursor(items.at(-1)!) : null,
    };
  }

  async upsertPreferenceSignal(
    input: Parameters<PreferencesRepository['upsertPreferenceSignal']>[0],
  ): Promise<PreferenceSignal> {
    return this.sqlite.transaction(() => {
      if (input.kind === 'like' || input.kind === 'dislike') {
        this.sqlite
          .prepare('DELETE FROM preference_signals WHERE target_key=? AND kind=?')
          .run(input.targetKey, input.kind === 'like' ? 'dislike' : 'like');
      }
      const existing = this.sqlite
        .prepare('SELECT id,created_at FROM preference_signals WHERE target_key=? AND kind=?')
        .get(input.targetKey, input.kind) as SqlRow | undefined;
      const id = existing ? String(existing.id) : randomUUID();
      const timestamp = new Date().toISOString();
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
      appendEvent(this.sqlite, {
        type: 'preferences.signal.updated',
        aggregateType: 'preference-signal',
        aggregateId: id,
        payload: { targetKey: input.targetKey, kind: input.kind },
        occurredAt: timestamp,
      });
      return preferenceSignalRow(
        this.sqlite.prepare('SELECT * FROM preference_signals WHERE id=?').get(id) as SqlRow,
      );
    })();
  }

  async deletePreferenceSignal(id: string): Promise<boolean> {
    return this.sqlite.transaction(() => {
      const timestamp = new Date().toISOString();
      const deleted = this.sqlite.prepare('DELETE FROM preference_signals WHERE id=?').run(id);
      if (deleted.changes > 0) {
        appendEvent(this.sqlite, {
          type: 'preferences.signal.updated',
          aggregateType: 'preference-signal',
          aggregateId: id,
          payload: { deleted: true },
          occurredAt: timestamp,
        });
      }
      return deleted.changes > 0;
    })();
  }

  async clearPreferenceSignals(): Promise<number> {
    return this.sqlite.transaction(() => {
      const result = this.sqlite.prepare('DELETE FROM preference_signals').run();
      if (result.changes > 0) {
        appendEvent(this.sqlite, {
          type: 'preferences.signal.updated',
          aggregateType: 'preference-signals',
          aggregateId: 'all',
          payload: { cleared: result.changes },
          occurredAt: new Date().toISOString(),
        });
      }
      return result.changes;
    })();
  }
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
    content: preferenceContentSchema.parse(JSON.parse(String(row.content))),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function appendEvent(
  sqlite: Database.Database,
  input: {
    type: string;
    aggregateType: string;
    aggregateId: string;
    payload: Record<string, unknown>;
    occurredAt: string;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO platform_events(
         id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
       ) VALUES (?,?,1,'preferences',?,?,?,?)`,
    )
    .run(
      randomUUID(),
      input.type,
      input.aggregateType,
      input.aggregateId,
      JSON.stringify(input.payload),
      input.occurredAt,
    );
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
