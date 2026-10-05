import { createHmac, randomUUID } from 'node:crypto';
import { ExportError } from '@zhiyun/contracts';
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

export function outputAdapter(destination: OutputDestinationLike): OutputAdapter {
  switch (destination.type) {
    case 'webhook':
      return new WebhookOutputAdapter();
    case 'postgres':
      throw new ExportError(
        'PostgreSQL output has been removed. Choose a file destination or Webhook.',
      );
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
