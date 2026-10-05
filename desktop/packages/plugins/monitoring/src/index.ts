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
    { type: 'monitoring.alert.created', durable: true },
    { type: 'monitoring.alert.updated', durable: true },
    { type: 'monitoring.alert.resolved', durable: true },
    { type: 'monitoring.alert.deleted', durable: true },
    { type: 'monitoring.notification.local', durable: true },
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
    {
      id: '003-rule-alerts',
      tables: ['quality_rule_state', 'quality_alerts', 'quality_alert_runs'],
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
export * from './migrations/sqlite/index.js';
export * from './migrations/sqlite/003-rule-alerts.js';
export * from './persistence/sqlite/index.js';
