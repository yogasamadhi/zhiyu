import type { PluginManifest } from '@zhiyun/plugin-runtime';
export const outputsPlugin = {
  id: 'outputs',
  version: '1.0.0',
  dependencies: [
    {
      id: 'collection',
      range: '^1.0.0',
    },
    {
      id: 'datasets',
      range: '^1.0.0',
    },
  ],
  providedServices: [
    {
      id: 'outputs.service',
      version: '1.0.0',
      owner: 'outputs',
    },
  ],
  optionalCapabilities: ['credential.store', 'artifact.store'],
  routes: [
    {
      operationId: 'listOutputDestinations',
      method: 'GET',
      path: '/api/v2/output-destinations',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'createOutputDestination',
      method: 'POST',
      path: '/api/v2/output-destinations',
      requiredPermission: 'output.manage',
    },
    {
      operationId: 'getOutputDestination',
      method: 'GET',
      path: '/api/v2/output-destinations/{destinationId}',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'updateOutputDestination',
      method: 'PUT',
      path: '/api/v2/output-destinations/{destinationId}',
      requiredPermission: 'output.manage',
    },
    {
      operationId: 'deleteOutputDestination',
      method: 'DELETE',
      path: '/api/v2/output-destinations/{destinationId}',
      requiredPermission: 'output.manage',
    },
    {
      operationId: 'listDeliveryAttempts',
      method: 'GET',
      path: '/api/v2/delivery-attempts',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'retryDeliveryAttempt',
      method: 'POST',
      path: '/api/v2/delivery-attempts/{attemptId}/retry',
      requiredPermission: 'output.bind',
    },
    {
      operationId: 'testOutputDestination',
      method: 'POST',
      path: '/api/v2/output-destinations/{destinationId}/test',
      requiredPermission: 'output.manage',
    },
    {
      operationId: 'promptOutputCredential',
      method: 'POST',
      path: '/api/v2/output-destinations/{destinationId}/credential/prompt',
      requiredPermission: 'output.manage',
    },
    {
      operationId: 'listApiTokens',
      method: 'GET',
      path: '/api/v2/api-tokens',
      requiredPermission: 'output.manage',
    },
    {
      operationId: 'createApiToken',
      method: 'POST',
      path: '/api/v2/api-tokens',
      requiredPermission: 'output.manage',
    },
    {
      operationId: 'revokeApiToken',
      method: 'DELETE',
      path: '/api/v2/api-tokens/{tokenId}',
      requiredPermission: 'output.manage',
    },
  ],
  events: [
    {
      type: 'outputs.destination.updated',
      durable: true,
    },
    {
      type: 'outputs.bindings.updated',
      durable: true,
    },
    {
      type: 'outputs.api-token.updated',
      durable: true,
    },
    {
      type: 'outputs.delivery.succeeded',
      durable: true,
    },
    {
      type: 'outputs.delivery.failed',
      durable: true,
    },
    {
      type: 'outputs.event-notification.succeeded',
      durable: true,
    },
    {
      type: 'outputs.event-notification.failed',
      durable: true,
    },
  ],
  migrations: [
    {
      id: '001-initial',
      tables: ['output_destinations', 'task_output_bindings', 'delivery_attempts', 'api_tokens'],
    },
    {
      id: '002-destination-types',
      tables: [],
    },
    {
      id: '003-event-notification-attempts',
      tables: ['event_notification_attempts'],
    },
    {
      id: '004-delivery-metadata',
      tables: [],
    },
    {
      id: '005-webhook-event-subscriptions',
      tables: [],
    },
    {
      id: '006-recruitment-events',
      tables: [],
    },
  ],
  uiContributions: [
    {
      id: 'outputs.route',
      kind: 'route',
    },
    {
      id: 'outputs.navigation',
      kind: 'navigation',
    },
  ],
  backgroundHandlers: [
    {
      type: 'outputs.delivery.execute',
      resourceClass: 'delivery',
    },
    {
      type: 'outputs.event-notification.execute',
      resourceClass: 'delivery',
    },
  ],
} as const satisfies PluginManifest;
export default outputsPlugin;
