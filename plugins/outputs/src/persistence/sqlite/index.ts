import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { ApiToken, DeliveryAttempt, OutputDestination } from '@zhiyun/shared';
import type { OutputRepository } from '../../contracts/index.js';
import { outputsSqliteMigration001 } from '../../migrations/sqlite/index.js';

type SqlRow = Record<string, unknown>;
const MIGRATION_ID = '001-initial';

export class SqliteOutputRepository implements OutputRepository {
  private readonly sqlite: Database.Database;

  constructor(filePath: string) {
    this.sqlite = new Database(filePath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
  }

  async migrate(): Promise<void> {
    const checksum = sha256(outputsSqliteMigration001);
    const existing = this.sqlite
      .prepare('SELECT checksum FROM plugin_migrations WHERE plugin_id=? AND migration_id=?')
      .get('outputs', MIGRATION_ID) as SqlRow | undefined;
    if (existing) {
      if (existing.checksum !== checksum) {
        throw new Error('Migration checksum mismatch for outputs:001-initial');
      }
      return;
    }
    const started = performance.now();
    this.sqlite.transaction(() => {
      this.sqlite.exec(outputsSqliteMigration001);
      this.sqlite
        .prepare(
          `INSERT INTO plugin_migrations(
             plugin_id,migration_id,plugin_version,checksum,executed_at,duration_ms,result
           ) VALUES ('outputs',?,'1.0.0',?,?,?,'succeeded')`,
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

  async createDestination(
    input: Pick<OutputDestination, 'name' | 'type' | 'config' | 'credentialRef' | 'enabled'>,
  ): Promise<OutputDestination> {
    return this.sqlite.transaction(() => {
      const id = randomUUID();
      const timestamp = new Date().toISOString();
      this.sqlite
        .prepare(
          `INSERT INTO output_destinations(
             id,name,type,config,credential_ref,enabled,created_at,updated_at
           ) VALUES (?,?,?,?,?,?,?,?)`,
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
      appendEvent(this.sqlite, 'outputs.destination.updated', 'output-destination', id, {
        created: true,
      });
      return outputDestinationRow(
        this.sqlite.prepare('SELECT * FROM output_destinations WHERE id=?').get(id) as SqlRow,
      );
    })();
  }

  async listDestinations(): Promise<OutputDestination[]> {
    return (
      this.sqlite
        .prepare('SELECT * FROM output_destinations ORDER BY created_at DESC,id DESC')
        .all() as SqlRow[]
    ).map(outputDestinationRow);
  }

  async getDestination(id: string): Promise<OutputDestination | null> {
    const row = this.sqlite.prepare('SELECT * FROM output_destinations WHERE id=?').get(id) as
      SqlRow | undefined;
    return row ? outputDestinationRow(row) : null;
  }

  async updateDestination(
    id: string,
    input: Partial<Pick<OutputDestination, 'name' | 'config' | 'credentialRef' | 'enabled'>>,
  ): Promise<OutputDestination | null> {
    return this.sqlite.transaction(() => {
      const row = this.sqlite.prepare('SELECT * FROM output_destinations WHERE id=?').get(id) as
        SqlRow | undefined;
      if (!row) return null;
      const current = outputDestinationRow(row);
      this.sqlite
        .prepare(
          `UPDATE output_destinations SET
             name=?,config=?,credential_ref=?,enabled=?,updated_at=? WHERE id=?`,
        )
        .run(
          input.name ?? current.name,
          JSON.stringify(input.config ?? current.config),
          input.credentialRef === undefined ? current.credentialRef : input.credentialRef,
          Number(input.enabled ?? current.enabled),
          new Date().toISOString(),
          id,
        );
      appendEvent(this.sqlite, 'outputs.destination.updated', 'output-destination', id, {});
      return outputDestinationRow(
        this.sqlite.prepare('SELECT * FROM output_destinations WHERE id=?').get(id) as SqlRow,
      );
    })();
  }

  async deleteDestination(id: string): Promise<boolean> {
    return this.sqlite.transaction(() => {
      const result = this.sqlite.prepare('DELETE FROM output_destinations WHERE id=?').run(id);
      if (result.changes === 0) return false;
      appendEvent(this.sqlite, 'outputs.destination.updated', 'output-destination', id, {
        deleted: true,
      });
      return true;
    })();
  }

  async replaceTaskBindings(taskId: string, destinationIds: readonly string[]): Promise<void> {
    this.sqlite.transaction(() => {
      this.sqlite.prepare('DELETE FROM task_output_bindings WHERE task_id=?').run(taskId);
      const insert = this.sqlite.prepare(
        'INSERT INTO task_output_bindings(task_id,destination_id,created_at) VALUES (?,?,?)',
      );
      const timestamp = new Date().toISOString();
      for (const destinationId of [...new Set(destinationIds)].sort()) {
        insert.run(taskId, destinationId, timestamp);
      }
      appendEvent(this.sqlite, 'outputs.bindings.updated', 'collection-task', taskId, {
        destinationIds: [...new Set(destinationIds)].sort(),
      });
    })();
  }

  async listTaskBindings(taskId: string): Promise<string[]> {
    return (
      this.sqlite
        .prepare(
          'SELECT destination_id FROM task_output_bindings WHERE task_id=? ORDER BY destination_id',
        )
        .all(taskId) as SqlRow[]
    ).map((row) => String(row.destination_id));
  }

  async clearTaskBindings(taskId: string): Promise<number> {
    return this.sqlite.transaction(() => {
      const result = this.sqlite
        .prepare('DELETE FROM task_output_bindings WHERE task_id=?')
        .run(taskId);
      if (result.changes > 0) {
        appendEvent(this.sqlite, 'outputs.bindings.updated', 'collection-task', taskId, {
          destinationIds: [],
        });
      }
      return result.changes;
    })();
  }

  async createDeliveryAttempt(
    input: Pick<DeliveryAttempt, 'destinationId' | 'taskId' | 'runId'>,
  ): Promise<DeliveryAttempt> {
    return this.sqlite.transaction(() => {
      const id = randomUUID();
      const timestamp = new Date().toISOString();
      this.sqlite
        .prepare(
          `INSERT INTO delivery_attempts(
             id,destination_id,task_id,run_id,status,attempt,created_at,updated_at
           ) VALUES (?,?,?,?,'pending',1,?,?)`,
        )
        .run(id, input.destinationId, input.taskId, input.runId, timestamp, timestamp);
      return deliveryAttemptRow(
        this.sqlite.prepare('SELECT * FROM delivery_attempts WHERE id=?').get(id) as SqlRow,
      );
    })();
  }

  async updateDeliveryAttempt(
    id: string,
    input: Partial<
      Pick<DeliveryAttempt, 'status' | 'attempt' | 'responseStatus' | 'error' | 'nextAttemptAt'>
    >,
  ): Promise<DeliveryAttempt | null> {
    return this.sqlite.transaction(() => {
      const row = this.sqlite.prepare('SELECT * FROM delivery_attempts WHERE id=?').get(id) as
        SqlRow | undefined;
      if (!row) return null;
      const current = deliveryAttemptRow(row);
      this.sqlite
        .prepare(
          `UPDATE delivery_attempts SET
             status=?,attempt=?,response_status=?,error=?,next_attempt_at=?,updated_at=? WHERE id=?`,
        )
        .run(
          input.status ?? current.status,
          input.attempt ?? current.attempt,
          input.responseStatus === undefined ? current.responseStatus : input.responseStatus,
          input.error === undefined ? current.error : input.error,
          input.nextAttemptAt === undefined ? current.nextAttemptAt : input.nextAttemptAt,
          new Date().toISOString(),
          id,
        );
      const updated = deliveryAttemptRow(
        this.sqlite.prepare('SELECT * FROM delivery_attempts WHERE id=?').get(id) as SqlRow,
      );
      if (updated.status === 'succeeded' || updated.status === 'failed') {
        appendEvent(this.sqlite, `outputs.delivery.${updated.status}`, 'delivery-attempt', id, {
          runId: updated.runId,
          destinationId: updated.destinationId,
        });
      }
      return updated;
    })();
  }

  async listDeliveryAttempts(runId?: string): Promise<DeliveryAttempt[]> {
    const rows = runId
      ? (this.sqlite
          .prepare(
            'SELECT * FROM delivery_attempts WHERE run_id=? ORDER BY created_at DESC,id DESC',
          )
          .all(runId) as SqlRow[])
      : (this.sqlite
          .prepare('SELECT * FROM delivery_attempts ORDER BY created_at DESC,id DESC')
          .all() as SqlRow[]);
    return rows.map(deliveryAttemptRow);
  }

  async createApiToken(
    input: Pick<ApiToken, 'name' | 'taskIds' | 'rateLimitPerMinute' | 'expiresAt'> & {
      tokenHash: string;
    },
  ): Promise<ApiToken> {
    return this.sqlite.transaction(() => {
      const id = randomUUID();
      const timestamp = new Date().toISOString();
      this.sqlite
        .prepare(
          `INSERT INTO api_tokens(
             id,name,token_hash,task_ids,rate_limit_per_minute,expires_at,revoked_at,created_at
           ) VALUES (?,?,?,?,?,?,NULL,?)`,
        )
        .run(
          id,
          input.name,
          input.tokenHash,
          JSON.stringify(input.taskIds),
          input.rateLimitPerMinute,
          input.expiresAt,
          timestamp,
        );
      appendEvent(this.sqlite, 'outputs.api-token.updated', 'api-token', id, { created: true });
      return apiTokenRow(
        this.sqlite.prepare('SELECT * FROM api_tokens WHERE id=?').get(id) as SqlRow,
      );
    })();
  }

  async listApiTokens(): Promise<ApiToken[]> {
    return (
      this.sqlite
        .prepare('SELECT * FROM api_tokens ORDER BY created_at DESC,id DESC')
        .all() as SqlRow[]
    ).map(apiTokenRow);
  }

  async findApiToken(tokenHash: string): Promise<ApiToken | null> {
    const row = this.sqlite
      .prepare('SELECT * FROM api_tokens WHERE token_hash=? AND revoked_at IS NULL')
      .get(tokenHash) as SqlRow | undefined;
    return row ? apiTokenRow(row) : null;
  }

  async revokeApiToken(id: string): Promise<boolean> {
    return this.sqlite.transaction(() => {
      const result = this.sqlite
        .prepare('UPDATE api_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL')
        .run(new Date().toISOString(), id);
      if (result.changes > 0) {
        appendEvent(this.sqlite, 'outputs.api-token.updated', 'api-token', id, { revoked: true });
      }
      return result.changes > 0;
    })();
  }
}

function outputDestinationRow(row: SqlRow): OutputDestination {
  return {
    id: String(row.id),
    name: String(row.name),
    type: row.type as OutputDestination['type'],
    config: parseObject(row.config),
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

function apiTokenRow(row: SqlRow): ApiToken {
  return {
    id: String(row.id),
    name: String(row.name),
    taskIds: JSON.parse(String(row.task_ids)) as string[],
    rateLimitPerMinute: Number(row.rate_limit_per_minute),
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    createdAt: String(row.created_at),
  };
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
       ) VALUES (?,?,1,'outputs',?,?,?,?)`,
    )
    .run(
      randomUUID(),
      type,
      aggregateType,
      aggregateId,
      JSON.stringify(payload),
      new Date().toISOString(),
    );
}

function parseObject(value: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(String(value));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
