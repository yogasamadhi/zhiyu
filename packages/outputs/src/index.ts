import { createHash, createHmac, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { ExportError, type DatasetSettings } from '@zhiyun/contracts';
import { GoogleSheetsOutputAdapter } from './google-sheets.js';
import { LocalDirectoryOutputAdapter } from './local-directory.js';
import { S3OutputAdapter } from './s3.js';
import type {
  OutputAdapter,
  OutputDeliveryInput,
  OutputDeliveryResult,
  OutputDestinationLike,
  OutputRecord,
} from './types.js';

export * from './types.js';
export {
  FileOutputArtifactStore,
  outputArtifactId,
  outputArtifactSpec,
  type OutputArtifactMaterializationInput,
  type OutputArtifactStore,
} from './artifacts.js';
export { GoogleSheetsOutputAdapter, googleServiceAccountClientEmail } from './google-sheets.js';
export { LocalDirectoryOutputAdapter, safeRelativePath } from './local-directory.js';
export { AwsSigV4S3Transport, S3OutputAdapter } from './s3.js';
export type { S3ObjectMetadata, S3PutInput, S3Transport } from './s3.js';
export { parseFields } from './serialization.js';
export { sendWebhookEventNotification, webhookSubscribes } from './webhook-events.js';
export type {
  OutputEventEnvelope,
  OutputEventSeverity,
  WebhookEventNotificationInput,
} from './webhook-events.js';

async function* batches<T>(
  values: AsyncIterable<T> | Iterable<T>,
  count = 500,
): AsyncGenerator<T[]> {
  let group: T[] = [];
  for await (const value of values) {
    group.push(value);
    if (group.length < count) continue;
    yield group;
    group = [];
  }
  if (group.length > 0) yield group;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function recordKey(data: Record<string, unknown>, settings: DatasetSettings) {
  const value =
    settings.keyFields.length > 0 ? settings.keyFields.map((field) => data[field] ?? null) : data;
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function credentialObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function webhookDeliveryEvent(
  config: Record<string, unknown>,
): 'run.succeeded' | 'dataset.changed' {
  if (config.event === 'dataset.changed') return 'dataset.changed';
  if (config.event === 'run.succeeded') return 'run.succeeded';
  if (Array.isArray(config.events)) {
    if (config.events.includes('run.succeeded')) return 'run.succeeded';
    if (config.events.includes('dataset.changed')) return 'dataset.changed';
    throw new ExportError('Webhook does not subscribe to successful run deliveries');
  }
  return 'run.succeeded';
}

export class WebhookOutputAdapter implements OutputAdapter {
  readonly type = 'webhook' as const;

  async test(
    input: Pick<OutputDeliveryInput, 'destination' | 'credential' | 'signal'>,
  ): Promise<void> {
    const url = String(input.destination.config.url ?? '');
    if (!/^https?:\/\//.test(url)) throw new ExportError('Webhook URL must use HTTP or HTTPS');
    const secret = String(credentialObject(input.credential).secret ?? '');
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const payload = JSON.stringify({ event: 'connection.test', nonce: randomUUID() });
    const signature = secret
      ? createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')
      : '';
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-zhiyun-timestamp': timestamp,
        'x-zhiyun-idempotency-key': `test:${randomUUID()}`,
        ...(signature ? { 'x-zhiyun-signature': `sha256=${signature}` } : {}),
      },
      body: payload,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!response.ok) throw new ExportError(`Webhook returned HTTP ${response.status}`);
  }

  async deliver(input: OutputDeliveryInput): Promise<OutputDeliveryResult> {
    const url = String(input.destination.config.url ?? '');
    if (!/^https?:\/\//.test(url)) throw new ExportError('Webhook URL must use HTTP or HTTPS');
    const secret = String(credentialObject(input.credential).secret ?? '');
    const event = webhookDeliveryEvent(input.destination.config);
    let delivered = 0;
    let status: number | null = null;
    let batch = 1;
    let items: OutputRecord[] = [];
    const send = async (records: OutputRecord[]) => {
      const timestamp = String(Math.floor(Date.now() / 1_000));
      const payload = JSON.stringify({
        event,
        taskId: input.taskId,
        runId: input.runId,
        batch,
        ...(event === 'dataset.changed' ? { changes: input.datasetStats } : {}),
        records,
      });
      if (Buffer.byteLength(payload) > 1024 * 1024)
        throw new ExportError('A single Webhook record exceeds the 1 MB payload limit');
      const signature = secret
        ? createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')
        : '';
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-zhiyun-timestamp': timestamp,
          'x-zhiyun-idempotency-key':
            event === 'dataset.changed'
              ? `${input.runId}:dataset:${batch}`
              : `${input.runId}:${batch}`,
          ...(signature ? { 'x-zhiyun-signature': `sha256=${signature}` } : {}),
        },
        body: payload,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      status = response.status;
      if (!response.ok) throw new ExportError(`Webhook returned HTTP ${response.status}`);
      delivered += records.length;
      batch += 1;
    };
    for await (const record of input.records) {
      const candidate = [...items, record];
      const candidatePayload = JSON.stringify({
        event,
        taskId: input.taskId,
        runId: input.runId,
        batch,
        ...(event === 'dataset.changed' ? { changes: input.datasetStats } : {}),
        records: candidate,
      });
      if (candidate.length > 500 || Buffer.byteLength(candidatePayload) > 1024 * 1024) {
        if (items.length === 0) await send(candidate);
        else {
          await send(items);
          items = [record];
        }
      } else {
        items = candidate;
      }
    }
    if (items.length > 0) await send(items);
    return { responseStatus: status, delivered };
  }
}

function identifier(value: unknown, fallback: string): string {
  const text = typeof value === 'string' && value ? value : fallback;
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(text))
    throw new ExportError(`Invalid PostgreSQL identifier: ${text}`);
  return text;
}

export class PostgresOutputAdapter implements OutputAdapter {
  readonly type = 'postgres' as const;

  async test(
    input: Pick<OutputDeliveryInput, 'destination' | 'credential' | 'signal'>,
  ): Promise<void> {
    const credentials = credentialObject(input.credential);
    const connectionString = String(credentials.connectionString ?? '');
    if (
      !connectionString.startsWith('postgres://') &&
      !connectionString.startsWith('postgresql://')
    ) {
      throw new ExportError('A PostgreSQL connection string is required');
    }
    identifier(input.destination.config.schema, 'public');
    identifier(input.destination.config.table, 'zhiyun_records');
    const sql = postgres(connectionString, { max: 1, connect_timeout: 10, idle_timeout: 5 });
    const abort = () => void sql.end({ timeout: 0 });
    input.signal?.addEventListener('abort', abort, { once: true });
    try {
      await sql`SELECT 1`;
    } finally {
      input.signal?.removeEventListener('abort', abort);
      await sql.end({ timeout: 5 });
    }
  }

  async deliver(input: OutputDeliveryInput): Promise<OutputDeliveryResult> {
    const credentials = credentialObject(input.credential);
    const connectionString = String(credentials.connectionString ?? '');
    if (
      !connectionString.startsWith('postgres://') &&
      !connectionString.startsWith('postgresql://')
    ) {
      throw new ExportError('A PostgreSQL connection string is required');
    }
    const schema = identifier(input.destination.config.schema, 'public');
    const table = identifier(input.destination.config.table, 'zhiyun_records');
    const sql = postgres(connectionString, { max: 2, connect_timeout: 10, idle_timeout: 5 });
    try {
      await sql`CREATE TABLE IF NOT EXISTS ${sql(schema)}.${sql(table)} (
        id uuid PRIMARY KEY,
        task_id uuid NOT NULL,
        run_id uuid NOT NULL,
        record_key text NOT NULL,
        data jsonb NOT NULL,
        source_url text NOT NULL,
        first_seen_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(task_id, record_key)
      )`;
      let delivered = 0;
      for await (const group of batches(input.records)) {
        await sql.begin(async (transaction) => {
          for (const record of group) {
            const key =
              input.datasetSettings.mode === 'append'
                ? `${input.runId}:${randomUUID()}`
                : recordKey(record.data, input.datasetSettings);
            if (input.datasetSettings.mode === 'append') {
              await transaction`INSERT INTO ${transaction(schema)}.${transaction(table)}
                (id,task_id,run_id,record_key,data,source_url) VALUES
                (${randomUUID()},${input.taskId},${input.runId},${key},${transaction.json(JSON.parse(JSON.stringify(record.data)))},${record.sourceUrl})`;
            } else {
              await transaction`INSERT INTO ${transaction(schema)}.${transaction(table)}
                (id,task_id,run_id,record_key,data,source_url) VALUES
                (${randomUUID()},${input.taskId},${input.runId},${key},${transaction.json(JSON.parse(JSON.stringify(record.data)))},${record.sourceUrl})
                ON CONFLICT(task_id,record_key) DO UPDATE SET
                  run_id=excluded.run_id,data=excluded.data,source_url=excluded.source_url,last_seen_at=now()`;
            }
          }
        });
        delivered += group.length;
      }
      return { responseStatus: null, delivered };
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
}

export function outputAdapter(destination: OutputDestinationLike): OutputAdapter {
  switch (destination.type) {
    case 'webhook':
      return new WebhookOutputAdapter();
    case 'postgres':
      return new PostgresOutputAdapter();
    case 'local-directory':
      return new LocalDirectoryOutputAdapter();
    case 'google-sheets':
      return new GoogleSheetsOutputAdapter();
    case 's3':
      return new S3OutputAdapter();
    default:
      throw new ExportError(`Unsupported output destination type: ${String(destination.type)}`);
  }
}
