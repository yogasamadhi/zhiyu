import type { ApiToken, DeliveryAttempt, OutputDestination } from '@zhiyun/shared';

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
      Pick<DeliveryAttempt, 'status' | 'attempt' | 'responseStatus' | 'error' | 'nextAttemptAt'>
    >,
  ): Promise<DeliveryAttempt | null>;
  listDeliveryAttempts(runId?: string): Promise<DeliveryAttempt[]>;
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

export type { ApiToken, DeliveryAttempt, OutputDestination };
