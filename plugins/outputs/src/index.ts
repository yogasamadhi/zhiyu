import type { PluginDescriptor } from '@zhiyun/kernel';

export const outputsPlugin: PluginDescriptor = {
  id: 'outputs',
  version: '1.0.0',
  dependencies: [
    { id: 'collection', range: '^1.0.0' },
    { id: 'datasets', range: '^1.0.0' },
  ],
  optionalCapabilities: ['credential.store', 'artifact.store'],
  routes: [
    { operationId: 'listOutputDestinations', method: 'GET', path: '/api/v2/output-destinations' },
    { operationId: 'createOutputDestination', method: 'POST', path: '/api/v2/output-destinations' },
    { operationId: 'listDeliveryAttempts', method: 'GET', path: '/api/v2/delivery-attempts' },
  ],
  events: [
    { type: 'outputs.delivery.succeeded', durable: true },
    { type: 'outputs.delivery.failed', durable: true },
  ],
  migrations: [
    {
      id: '001-initial',
      tables: ['output_destinations', 'task_output_bindings', 'delivery_attempts', 'api_tokens'],
    },
  ],
  uiContributions: [
    { id: 'outputs.route', kind: 'route' },
    { id: 'outputs.navigation', kind: 'navigation' },
  ],
  backgroundHandlers: [{ type: 'outputs.delivery.execute', resourceClass: 'delivery' }],
  activate() {},
};
