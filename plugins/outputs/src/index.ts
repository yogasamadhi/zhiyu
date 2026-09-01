import { createServiceToken, type PluginDescriptor } from '@zhiyun/kernel';
import type { OutputsServiceContract } from './contracts/index.js';
import { outputsRoutes } from './http/index.js';
import { outputsUiContributions } from './ui/index.js';

export const outputsService = createServiceToken<OutputsServiceContract>(
  'outputs.service',
  '1.0.0',
  'outputs',
);

export const outputsPlugin: PluginDescriptor = {
  id: 'outputs',
  version: '1.0.0',
  dependencies: [
    { id: 'collection', range: '^1.0.0' },
    { id: 'datasets', range: '^1.0.0' },
  ],
  providedServices: [outputsService],
  optionalCapabilities: ['credential.store', 'artifact.store'],
  routes: outputsRoutes,
  events: [
    { type: 'outputs.destination.updated', durable: true },
    { type: 'outputs.bindings.updated', durable: true },
    { type: 'outputs.api-token.updated', durable: true },
    { type: 'outputs.delivery.succeeded', durable: true },
    { type: 'outputs.delivery.failed', durable: true },
    { type: 'outputs.event-notification.succeeded', durable: true },
    { type: 'outputs.event-notification.failed', durable: true },
  ],
  migrations: [
    {
      id: '001-initial',
      tables: ['output_destinations', 'task_output_bindings', 'delivery_attempts', 'api_tokens'],
    },
    { id: '002-destination-types', tables: [] },
    { id: '003-event-notification-attempts', tables: ['event_notification_attempts'] },
    { id: '004-delivery-metadata', tables: [] },
    { id: '005-webhook-event-subscriptions', tables: [] },
  ],
  uiContributions: outputsUiContributions,
  backgroundHandlers: [
    { type: 'outputs.delivery.execute', resourceClass: 'delivery' },
    { type: 'outputs.event-notification.execute', resourceClass: 'delivery' },
  ],
  activate() {},
};

export * from './application/index.js';
export * from './application/attempt-replay.js';
export * from './application/event-outbox.js';
export * from './contracts/index.js';
export * from './domain/index.js';
export * from './http/index.js';
export * from './persistence/postgres/index.js';
export * from './persistence/sqlite/index.js';
export * from './ui/index.js';
