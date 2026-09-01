import {
  DurableEventDispatcher,
  type PlatformEvent,
  type PlatformJobQueue,
  type PlatformRepository,
} from '@zhiyun/platform-core';
import { redactSensitiveValue, type WebhookEventType } from '@zhiyun/shared';
import type { OutputRepository } from '../contracts/index.js';
import { enqueueOutputEventNotifications } from './index.js';

const notificationEventTypes = [
  'run.succeeded',
  'run.failed',
  'dataset.changed',
  'quality.issue.detected',
  'quality.recovered',
  'recruitment.match.detected',
  'recruitment.posting.changed',
  'recruitment.digest.ready',
] as const satisfies readonly WebhookEventType[];

/** Durable platform-event consumer that materializes notification outbox attempts. */
export class OutputEventNotificationOutbox {
  private readonly dispatcher: DurableEventDispatcher;
  private timer: ReturnType<typeof setInterval> | undefined;
  private dispatching = false;

  constructor(
    platform: PlatformRepository,
    repository: OutputRepository,
    jobs: PlatformJobQueue,
    private readonly intervalMs = 5_000,
  ) {
    this.dispatcher = new DurableEventDispatcher(platform, [
      {
        consumerId: 'outputs.event-notifications.v1',
        eventTypes: notificationEventTypes,
        async handle(event) {
          const input = notificationInput(event);
          if (!input) return;
          await enqueueOutputEventNotifications({ repository, jobs }, input);
        },
      },
    ]);
  }

  async start(): Promise<void> {
    await this.dispatch();
    this.timer = setInterval(() => void this.dispatch(), Math.max(1_000, this.intervalMs));
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async dispatch(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      await this.dispatcher.dispatchOnce(1_000);
    } finally {
      this.dispatching = false;
    }
  }
}

function notificationInput(event: PlatformEvent) {
  if (!isNotificationEventType(event.type)) return null;
  const taskId = stringValue(event.payload.taskId);
  if (!taskId) return null;
  const runId = stringValue(event.payload.runId);
  const payload = redactSensitiveValue(event.payload) as Record<string, unknown>;
  return {
    eventId: event.id,
    type: event.type,
    occurredAt: event.occurredAt,
    taskId,
    runId,
    severity: severity(event.type, event.payload),
    payload,
  };
}

function severity(
  type: WebhookEventType,
  payload: Record<string, unknown>,
): 'info' | 'warning' | 'error' {
  if (type === 'run.failed') return 'error';
  if (type === 'quality.issue.detected') return payload.status === 'failing' ? 'error' : 'warning';
  return 'info';
}

function isNotificationEventType(value: string): value is WebhookEventType {
  return (notificationEventTypes as readonly string[]).includes(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}
