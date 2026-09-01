import { createServiceToken, type PluginDescriptor } from '@zhiyun/kernel';
import type { MonitoringRepository } from './contracts/index.js';
import { monitoringRoutes } from './http/index.js';

export const monitoringService = createServiceToken<MonitoringRepository>(
  'monitoring.service',
  '1.0.0',
  'monitoring',
);

export const monitoringPlugin: PluginDescriptor = {
  id: 'monitoring',
  version: '1.0.0',
  dependencies: [
    { id: 'collection', range: '^1.0.0' },
    { id: 'datasets', range: '^1.0.0' },
  ],
  providedServices: [monitoringService],
  optionalCapabilities: ['host.notifications'],
  routes: monitoringRoutes,
  events: [
    { type: 'quality.issue.detected', durable: true },
    { type: 'quality.recovered', durable: true },
  ],
  migrations: [
    {
      id: '001-initial',
      tables: ['quality_policies', 'quality_evaluations'],
    },
    {
      id: '002-durable-notifications',
      tables: ['quality_task_state', 'quality_notifications'],
    },
  ],
  backgroundHandlers: [{ type: 'monitoring.quality.evaluate', resourceClass: 'io' }],
  activate() {},
};

export * from './application/index.js';
export * from './application/jobs.js';
export * from './contracts/index.js';
export * from './domain/index.js';
export * from './http/index.js';
export * from './migrations/postgres/index.js';
export * from './migrations/sqlite/index.js';
export * from './persistence/postgres/index.js';
export * from './persistence/sqlite/index.js';
