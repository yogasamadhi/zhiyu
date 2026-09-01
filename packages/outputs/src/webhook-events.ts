import { createHmac } from 'node:crypto';
import { ExportError, redactSensitiveValue, type WebhookEventType } from '@zhiyun/contracts';
import type { OutputDestinationLike } from './types.js';

export type OutputEventSeverity = 'info' | 'warning' | 'error';

export interface OutputEventEnvelope {
  schemaVersion: 1;
  eventId: string;
  type: WebhookEventType;
  occurredAt: string;
  taskId: string;
  runId: string | null;
  severity: OutputEventSeverity;
  payload: Record<string, unknown>;
}

export interface WebhookEventNotificationInput {
  destination: OutputDestinationLike;
  envelope: OutputEventEnvelope;
  credential: unknown;
  signal?: AbortSignal;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function webhookSubscribes(
  config: Record<string, unknown>,
  type: WebhookEventType,
): boolean {
  if (Array.isArray(config.events)) return config.events.includes(type);
  if (typeof config.event === 'string') return config.event === type;
  return type === 'run.succeeded';
}

export async function sendWebhookEventNotification(
  input: WebhookEventNotificationInput,
): Promise<{ responseStatus: number }> {
  if (input.destination.type !== 'webhook') {
    throw new ExportError('Event notifications require a Webhook destination');
  }
  if (!webhookSubscribes(input.destination.config, input.envelope.type)) {
    throw new ExportError(`Webhook does not subscribe to ${input.envelope.type}`);
  }
  const url = String(input.destination.config.url ?? '');
  if (!/^https?:\/\//.test(url)) throw new ExportError('Webhook URL must use HTTP or HTTPS');
  const payload = JSON.stringify(redactSensitiveValue(input.envelope));
  if (Buffer.byteLength(payload) > 1024 * 1024) {
    throw new ExportError('Webhook event envelope exceeds the 1 MB payload limit');
  }
  const secret = String(objectValue(input.credential).secret ?? '');
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = secret
    ? createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')
    : '';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-zhiyun-timestamp': timestamp,
      'x-zhiyun-idempotency-key': input.envelope.eventId,
      ...(signature ? { 'x-zhiyun-signature': `sha256=${signature}` } : {}),
    },
    body: payload,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!response.ok) throw new ExportError(`Webhook returned HTTP ${response.status}`);
  return { responseStatus: response.status };
}
