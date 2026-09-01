import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import {
  assertNoSensitiveOutputConfig,
  outputDestinationSchema,
  stripOutputDestinationConfig,
  type ApiToken,
  type OutputDestination,
} from '@zhiyun/shared';
import type {
  DeliveryAttempt,
  EventNotificationAttempt,
  EventNotificationInput,
  OutputRepository,
} from '../../contracts/index.js';
import {
  outputsPostgresMigration001,
  outputsPostgresMigration002,
  outputsPostgresMigration003,
  outputsPostgresMigration004,
  outputsPostgresMigration005,
  outputsPostgresMigration006,
} from '../../migrations/postgres/index.js';

type PgRow = Record<string, unknown>;
type PostgresClient = ReturnType<typeof postgres>;
const MIGRATIONS = [
  { id: '001-initial', sql: outputsPostgresMigration001, version: '1.0.0' },
  { id: '002-destination-types', sql: outputsPostgresMigration002, version: '1.1.0' },
  { id: '003-event-notification-attempts', sql: outputsPostgresMigration003, version: '1.2.0' },
  { id: '004-delivery-metadata', sql: outputsPostgresMigration004, version: '1.3.0' },
  { id: '005-webhook-event-subscriptions', sql: outputsPostgresMigration005, version: '1.4.0' },
  { id: '006-recruitment-events', sql: outputsPostgresMigration006, version: '1.5.0' },
] as const;

export class PostgresOutputRepository implements OutputRepository {
  private readonly sql: PostgresClient;

  constructor(connectionString: string, maxConnections = 5) {
    this.sql = postgres(connectionString, { max: maxConnections });
  }

  async migrate(): Promise<void> {
    for (const migration of MIGRATIONS) {
      const checksum = sha256(migration.sql);
      const rows = await this.sql`
        SELECT checksum FROM plugin_migrations
        WHERE plugin_id='outputs' AND migration_id=${migration.id}
      `;
      if (rows[0]) {
        if (rows[0].checksum !== checksum) {
          throw new Error(`Migration checksum mismatch for outputs:${migration.id}`);
        }
        continue;
      }
      const started = performance.now();
      await this.sql.begin(async (transaction) => {
        await transaction.unsafe(migration.sql);
        await transaction`
          INSERT INTO plugin_migrations(
            plugin_id,migration_id,plugin_version,checksum,executed_at,duration_ms,result
          ) VALUES (
            'outputs',${migration.id},${migration.version},${checksum},${new Date()},
            ${Math.max(0, Math.round(performance.now() - started))},'succeeded'
          )
        `;
      });
    }
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  async createDestination(
    input: Pick<OutputDestination, 'name' | 'type' | 'config' | 'credentialRef' | 'enabled'>,
  ): Promise<OutputDestination> {
    assertNoSensitiveOutputConfig(input.config);
    const config = stripOutputDestinationConfig(input.type, input.config);
    return this.sql.begin(async (transaction) => {
      const id = randomUUID();
      const timestamp = new Date();
      const rows = await transaction`
        INSERT INTO output_destinations(
          id,name,type,config,credential_ref,enabled,created_at,updated_at
        ) VALUES (
          ${id},${input.name},${input.type},${transaction.json(jsonValue(config))},
          ${input.credentialRef},${input.enabled},${timestamp},${timestamp}
        ) RETURNING *
      `;
      await transaction`
        INSERT INTO platform_events(
          id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
        ) VALUES (
          ${randomUUID()},'outputs.destination.updated',1,'outputs','output-destination',${id},
          ${transaction.json(jsonValue({ created: true }))},${timestamp}
        )
      `;
      return outputDestinationRow(rows[0] as PgRow);
    });
  }

  async listDestinations(): Promise<OutputDestination[]> {
    const rows = await this.sql`
      SELECT * FROM output_destinations ORDER BY created_at DESC,id DESC
    `;
    return rows.map((row) => outputDestinationRow(row as PgRow));
  }

  async getDestination(id: string): Promise<OutputDestination | null> {
    const rows = await this.sql`SELECT * FROM output_destinations WHERE id=${id}`;
    return rows[0] ? outputDestinationRow(rows[0] as PgRow) : null;
  }

  async updateDestination(
    id: string,
    input: Partial<Pick<OutputDestination, 'name' | 'config' | 'credentialRef' | 'enabled'>>,
  ): Promise<OutputDestination | null> {
    return this.sql.begin(async (transaction) => {
      const selected = await transaction`
        SELECT * FROM output_destinations WHERE id=${id} FOR UPDATE
      `;
      const row = selected[0] as PgRow | undefined;
      if (!row) return null;
      const current = outputDestinationRow(row);
      const config =
        input.config === undefined
          ? current.config
          : (() => {
              assertNoSensitiveOutputConfig(input.config);
              return stripOutputDestinationConfig(current.type, input.config);
            })();
      const timestamp = new Date();
      const rows = await transaction`
        UPDATE output_destinations SET
          name=${input.name ?? current.name},
          config=${transaction.json(jsonValue(config))},
          credential_ref=${input.credentialRef === undefined ? current.credentialRef : input.credentialRef},
          enabled=${input.enabled ?? current.enabled},updated_at=${timestamp}
        WHERE id=${id} RETURNING *
      `;
      await transaction`
        INSERT INTO platform_events(
          id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
        ) VALUES (
          ${randomUUID()},'outputs.destination.updated',1,'outputs','output-destination',${id},
          ${transaction.json(jsonValue({}))},${timestamp}
        )
      `;
      return outputDestinationRow(rows[0] as PgRow);
    });
  }

  async deleteDestination(id: string): Promise<boolean> {
    return this.sql.begin(async (transaction) => {
      const rows = await transaction`
        DELETE FROM output_destinations WHERE id=${id} RETURNING id
      `;
      if (rows.length === 0) return false;
      await transaction`
        INSERT INTO platform_events(
          id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
        ) VALUES (
          ${randomUUID()},'outputs.destination.updated',1,'outputs','output-destination',${id},
          ${transaction.json(jsonValue({ deleted: true }))},${new Date()}
        )
      `;
      return true;
    });
  }

  async replaceTaskBindings(taskId: string, destinationIds: readonly string[]): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const unique = [...new Set(destinationIds)].sort();
      await transaction`DELETE FROM task_output_bindings WHERE task_id=${taskId}`;
      const timestamp = new Date();
      for (const destinationId of unique) {
        await transaction`
          INSERT INTO task_output_bindings(task_id,destination_id,created_at)
          VALUES (${taskId},${destinationId},${timestamp})
        `;
      }
      await transaction`
        INSERT INTO platform_events(
          id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
        ) VALUES (
          ${randomUUID()},'outputs.bindings.updated',1,'outputs','collection-task',${taskId},
          ${transaction.json(jsonValue({ destinationIds: unique }))},${timestamp}
        )
      `;
    });
  }

  async listTaskBindings(taskId: string): Promise<string[]> {
    const rows = await this.sql`
      SELECT destination_id FROM task_output_bindings
      WHERE task_id=${taskId} ORDER BY destination_id
    `;
    return rows.map((row) => String(row.destination_id));
  }

  async clearTaskBindings(taskId: string): Promise<number> {
    return this.sql.begin(async (transaction) => {
      const rows = await transaction`
        DELETE FROM task_output_bindings WHERE task_id=${taskId} RETURNING destination_id
      `;
      if (rows.length > 0) {
        await transaction`
          INSERT INTO platform_events(
            id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
          ) VALUES (
            ${randomUUID()},'outputs.bindings.updated',1,'outputs','collection-task',${taskId},
            ${transaction.json(jsonValue({ destinationIds: [] }))},${new Date()}
          )
        `;
      }
      return rows.length;
    });
  }

  async createDeliveryAttempt(
    input: Pick<DeliveryAttempt, 'destinationId' | 'taskId' | 'runId'>,
  ): Promise<DeliveryAttempt> {
    const timestamp = new Date();
    const rows = await this.sql`
      INSERT INTO delivery_attempts(
        id,destination_id,task_id,run_id,status,attempt,created_at,updated_at
      ) VALUES (
        ${randomUUID()},${input.destinationId},${input.taskId},${input.runId},
        'pending',1,${timestamp},${timestamp}
      ) RETURNING *
    `;
    return deliveryAttemptRow(rows[0] as PgRow);
  }

  async updateDeliveryAttempt(
    id: string,
    input: Partial<
      Pick<
        DeliveryAttempt,
        | 'status'
        | 'attempt'
        | 'responseStatus'
        | 'error'
        | 'nextAttemptAt'
        | 'format'
        | 'artifactId'
        | 'finalLocation'
        | 'sha256'
        | 'deliveredRecordCount'
      >
    >,
  ): Promise<DeliveryAttempt | null> {
    return this.sql.begin(async (transaction) => {
      const selected = await transaction`
        SELECT * FROM delivery_attempts WHERE id=${id} FOR UPDATE
      `;
      const row = selected[0] as PgRow | undefined;
      if (!row) return null;
      const current = deliveryAttemptRow(row);
      const timestamp = new Date();
      const rows = await transaction`
        UPDATE delivery_attempts SET
          status=${input.status ?? current.status},attempt=${input.attempt ?? current.attempt},
          response_status=${input.responseStatus === undefined ? current.responseStatus : input.responseStatus},
          error=${input.error === undefined ? current.error : input.error},
          next_attempt_at=${
            input.nextAttemptAt === undefined
              ? current.nextAttemptAt
                ? new Date(current.nextAttemptAt)
                : null
              : input.nextAttemptAt
                ? new Date(input.nextAttemptAt)
                : null
          },format=${input.format === undefined ? current.format : input.format},
          artifact_id=${input.artifactId === undefined ? current.artifactId : input.artifactId},
          final_location=${
            input.finalLocation === undefined ? current.finalLocation : input.finalLocation
          },sha256=${input.sha256 === undefined ? current.sha256 : input.sha256},
          delivered_record_count=${
            input.deliveredRecordCount === undefined
              ? current.deliveredRecordCount
              : input.deliveredRecordCount
          },updated_at=${timestamp}
        WHERE id=${id} RETURNING *
      `;
      const updated = deliveryAttemptRow(rows[0] as PgRow);
      if (updated.status === 'succeeded' || updated.status === 'failed') {
        await transaction`
          INSERT INTO platform_events(
            id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
          ) VALUES (
            ${randomUUID()},${`outputs.delivery.${updated.status}`},1,'outputs','delivery-attempt',
            ${id},${transaction.json(
              jsonValue({ runId: updated.runId, destinationId: updated.destinationId }),
            )},${timestamp}
          )
        `;
      }
      return updated;
    });
  }

  async listDeliveryAttempts(runId?: string): Promise<DeliveryAttempt[]> {
    const rows = runId
      ? await this.sql`
          SELECT * FROM delivery_attempts WHERE run_id=${runId}
          ORDER BY created_at DESC,id DESC
        `
      : await this.sql`
          SELECT * FROM delivery_attempts ORDER BY created_at DESC,id DESC
        `;
    return rows.map((row) => deliveryAttemptRow(row as PgRow));
  }

  async createEventNotificationAttempt(
    input: EventNotificationInput & { destinationId: string },
  ): Promise<EventNotificationAttempt> {
    const timestamp = new Date();
    const inserted = await this.sql`
      INSERT INTO event_notification_attempts(
        id,destination_id,event_id,event_type,occurred_at,task_id,run_id,severity,payload,
        status,attempt,created_at,updated_at
      ) VALUES (
        ${randomUUID()},${input.destinationId},${input.eventId},${input.type},
        ${new Date(input.occurredAt)},${input.taskId},${input.runId},${input.severity},
        ${this.sql.json(jsonValue(input.payload))},'pending',1,${timestamp},${timestamp}
      ) ON CONFLICT(destination_id,event_id) DO NOTHING
      RETURNING *
    `;
    if (inserted[0]) return eventNotificationAttemptRow(inserted[0] as PgRow);
    const existing = await this.sql`
      SELECT * FROM event_notification_attempts
      WHERE destination_id=${input.destinationId} AND event_id=${input.eventId}
    `;
    return eventNotificationAttemptRow(existing[0] as PgRow);
  }

  async getEventNotificationAttempt(id: string): Promise<EventNotificationAttempt | null> {
    const rows = await this.sql`SELECT * FROM event_notification_attempts WHERE id=${id}`;
    return rows[0] ? eventNotificationAttemptRow(rows[0] as PgRow) : null;
  }

  async updateEventNotificationAttempt(
    id: string,
    input: Partial<
      Pick<
        EventNotificationAttempt,
        'status' | 'attempt' | 'responseStatus' | 'error' | 'nextAttemptAt'
      >
    >,
  ): Promise<EventNotificationAttempt | null> {
    return this.sql.begin(async (transaction) => {
      const selected = await transaction`
        SELECT * FROM event_notification_attempts WHERE id=${id} FOR UPDATE
      `;
      const row = selected[0] as PgRow | undefined;
      if (!row) return null;
      const current = eventNotificationAttemptRow(row);
      const timestamp = new Date();
      const rows = await transaction`
        UPDATE event_notification_attempts SET
          status=${input.status ?? current.status},
          attempt=${input.attempt ?? current.attempt},
          response_status=${input.responseStatus === undefined ? current.responseStatus : input.responseStatus},
          error=${input.error === undefined ? current.error : input.error},
          next_attempt_at=${
            input.nextAttemptAt === undefined
              ? current.nextAttemptAt
                ? new Date(current.nextAttemptAt)
                : null
              : input.nextAttemptAt
                ? new Date(input.nextAttemptAt)
                : null
          },
          updated_at=${timestamp}
        WHERE id=${id} RETURNING *
      `;
      const updated = eventNotificationAttemptRow(rows[0] as PgRow);
      if (updated.status === 'succeeded' || updated.status === 'failed') {
        await transaction`
          INSERT INTO platform_events(
            id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
          ) VALUES (
            ${randomUUID()},${`outputs.event-notification.${updated.status}`},1,'outputs',
            'event-notification-attempt',${id},${transaction.json(
              jsonValue({
                eventId: updated.eventId,
                type: updated.type,
                destinationId: updated.destinationId,
              }),
            )},${timestamp}
          )
        `;
      }
      return updated;
    });
  }

  async listEventNotificationAttempts(eventId?: string): Promise<EventNotificationAttempt[]> {
    const rows = eventId
      ? await this.sql`
          SELECT * FROM event_notification_attempts WHERE event_id=${eventId}
          ORDER BY created_at DESC,id DESC
        `
      : await this.sql`
          SELECT * FROM event_notification_attempts ORDER BY created_at DESC,id DESC
        `;
    return rows.map((row) => eventNotificationAttemptRow(row as PgRow));
  }

  async createApiToken(
    input: Pick<ApiToken, 'name' | 'taskIds' | 'rateLimitPerMinute' | 'expiresAt'> & {
      tokenHash: string;
    },
  ): Promise<ApiToken> {
    return this.sql.begin(async (transaction) => {
      const id = randomUUID();
      const timestamp = new Date();
      const rows = await transaction`
        INSERT INTO api_tokens(
          id,name,token_hash,task_ids,rate_limit_per_minute,expires_at,revoked_at,created_at
        ) VALUES (
          ${id},${input.name},${input.tokenHash},${transaction.json(jsonValue(input.taskIds))},
          ${input.rateLimitPerMinute},${input.expiresAt ? new Date(input.expiresAt) : null},
          NULL,${timestamp}
        ) RETURNING *
      `;
      await transaction`
        INSERT INTO platform_events(
          id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
        ) VALUES (
          ${randomUUID()},'outputs.api-token.updated',1,'outputs','api-token',${id},
          ${transaction.json(jsonValue({ created: true }))},${timestamp}
        )
      `;
      return apiTokenRow(rows[0] as PgRow);
    });
  }

  async listApiTokens(): Promise<ApiToken[]> {
    const rows = await this.sql`SELECT * FROM api_tokens ORDER BY created_at DESC,id DESC`;
    return rows.map((row) => apiTokenRow(row as PgRow));
  }

  async findApiToken(tokenHash: string): Promise<ApiToken | null> {
    const rows = await this.sql`
      SELECT * FROM api_tokens WHERE token_hash=${tokenHash} AND revoked_at IS NULL
    `;
    return rows[0] ? apiTokenRow(rows[0] as PgRow) : null;
  }

  async revokeApiToken(id: string): Promise<boolean> {
    return this.sql.begin(async (transaction) => {
      const timestamp = new Date();
      const rows = await transaction`
        UPDATE api_tokens SET revoked_at=${timestamp}
        WHERE id=${id} AND revoked_at IS NULL RETURNING id
      `;
      if (rows.length === 0) return false;
      await transaction`
        INSERT INTO platform_events(
          id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
        ) VALUES (
          ${randomUUID()},'outputs.api-token.updated',1,'outputs','api-token',${id},
          ${transaction.json(jsonValue({ revoked: true }))},${timestamp}
        )
      `;
      return true;
    });
  }
}

function outputDestinationRow(row: PgRow): OutputDestination {
  const type = row.type as OutputDestination['type'];
  return outputDestinationSchema.parse({
    id: String(row.id),
    name: String(row.name),
    type,
    config: stripOutputDestinationConfig(type, objectValue(row.config)),
    credentialRef: row.credential_ref ? String(row.credential_ref) : null,
    enabled: Boolean(row.enabled),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function deliveryAttemptRow(row: PgRow): DeliveryAttempt {
  return {
    id: String(row.id),
    destinationId: String(row.destination_id),
    taskId: String(row.task_id),
    runId: String(row.run_id),
    status: row.status as DeliveryAttempt['status'],
    attempt: Number(row.attempt),
    responseStatus: row.response_status === null ? null : Number(row.response_status),
    error: row.error ? String(row.error) : null,
    nextAttemptAt: nullableIso(row.next_attempt_at),
    format: row.format ? (String(row.format) as DeliveryAttempt['format']) : null,
    artifactId: row.artifact_id ? String(row.artifact_id) : null,
    finalLocation: row.final_location ? String(row.final_location) : null,
    sha256: row.sha256 ? String(row.sha256) : null,
    deliveredRecordCount:
      row.delivered_record_count === null || row.delivered_record_count === undefined
        ? null
        : Number(row.delivered_record_count),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function eventNotificationAttemptRow(row: PgRow): EventNotificationAttempt {
  return {
    id: String(row.id),
    destinationId: String(row.destination_id),
    eventId: String(row.event_id),
    type: row.event_type as EventNotificationAttempt['type'],
    occurredAt: iso(row.occurred_at),
    taskId: String(row.task_id),
    runId: row.run_id ? String(row.run_id) : null,
    severity: row.severity as EventNotificationAttempt['severity'],
    payload: objectValue(row.payload),
    status: row.status as EventNotificationAttempt['status'],
    attempt: Number(row.attempt),
    responseStatus: row.response_status === null ? null : Number(row.response_status),
    error: row.error ? String(row.error) : null,
    nextAttemptAt: nullableIso(row.next_attempt_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function apiTokenRow(row: PgRow): ApiToken {
  return {
    id: String(row.id),
    name: String(row.name),
    taskIds: Array.isArray(row.task_ids) ? row.task_ids.map(String) : [],
    rateLimitPerMinute: Number(row.rate_limit_per_minute),
    expiresAt: nullableIso(row.expires_at),
    revokedAt: nullableIso(row.revoked_at),
    createdAt: iso(row.created_at),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function jsonValue(value: unknown): Parameters<PostgresClient['json']>[0] {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Value is not JSON serializable');
  return JSON.parse(serialized) as Parameters<PostgresClient['json']>[0];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
