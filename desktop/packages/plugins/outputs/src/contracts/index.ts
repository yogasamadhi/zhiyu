import type {
  ApiToken,
  DeliveryAttempt as SharedDeliveryAttempt,
  OutputDestination,
  WebhookEventType,
} from '@zhiyun/shared';
import type { OutputFileFormat } from '@zhiyun/outputs';

export interface DeliveryAttempt extends SharedDeliveryAttempt {
  format: OutputFileFormat | null;
  artifactId: string | null;
  finalLocation: string | null;
  sha256: string | null;
  deliveredRecordCount: number | null;
}

export type EventNotificationSeverity = 'info' | 'warning' | 'error';
export type EventNotificationStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface EventNotificationInput {
  eventId: string;
  type: WebhookEventType;
  occurredAt: string;
  taskId: string;
  runId: string | null;
  severity: EventNotificationSeverity;
  payload: Record<string, unknown>;
}

export interface EventNotificationAttempt extends EventNotificationInput {
  id: string;
  destinationId: string;
  status: EventNotificationStatus;
  attempt: number;
  responseStatus: number | null;
  error: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OutputRepository {
  migrate(): Promise<void>;
  close(): Promise<void>;
  createDestination(
    input: Pick<OutputDestination, 'name' | 'type' | 'config' | 'credentialRef' | 'enabled'>,
  ): Promise<OutputDestination>;
  listDestinations(): Promise<OutputDestination[]>;
  getDestination(id: string): Promise<OutputDestination | null>;
  updateDestination(
    id: string,
    input: Partial<Pick<OutputDestination, 'name' | 'config' | 'credentialRef' | 'enabled'>>,
  ): Promise<OutputDestination | null>;
  deleteDestination(id: string): Promise<boolean>;
  replaceTaskBindings(taskId: string, destinationIds: readonly string[]): Promise<void>;
  listTaskBindings(taskId: string): Promise<string[]>;
  clearTaskBindings(taskId: string): Promise<number>;
  createDeliveryAttempt(
    input: Pick<DeliveryAttempt, 'destinationId' | 'taskId' | 'runId'>,
  ): Promise<DeliveryAttempt>;
  updateDeliveryAttempt(
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
  ): Promise<DeliveryAttempt | null>;
  listDeliveryAttempts(runId?: string): Promise<DeliveryAttempt[]>;
  createEventNotificationAttempt(
    input: EventNotificationInput & { destinationId: string },
  ): Promise<EventNotificationAttempt>;
  getEventNotificationAttempt(id: string): Promise<EventNotificationAttempt | null>;
  updateEventNotificationAttempt(
    id: string,
    input: Partial<
      Pick<
        EventNotificationAttempt,
        'status' | 'attempt' | 'responseStatus' | 'error' | 'nextAttemptAt'
      >
    >,
  ): Promise<EventNotificationAttempt | null>;
  listEventNotificationAttempts(eventId?: string): Promise<EventNotificationAttempt[]>;
  createApiToken(
    input: Pick<ApiToken, 'name' | 'taskIds' | 'rateLimitPerMinute' | 'expiresAt'> & {
      tokenHash: string;
    },
  ): Promise<ApiToken>;
  listApiTokens(): Promise<ApiToken[]>;
  findApiToken(tokenHash: string): Promise<ApiToken | null>;
  revokeApiToken(id: string): Promise<boolean>;
}

export interface OutputsServiceContract {
  listDestinations(): Promise<OutputDestination[]>;
  getDestination(id: string): Promise<OutputDestination | null>;
  bindTask(taskId: string, destinationIds: readonly string[]): Promise<void>;
  clearCollectionTask(taskId: string): Promise<number>;
}

export type { ApiToken, OutputDestination };
