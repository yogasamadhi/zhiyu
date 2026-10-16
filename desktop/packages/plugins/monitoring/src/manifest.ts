import type { PluginManifest } from '@zhiyun/plugin-runtime';
export const monitoringPlugin = {
  id: 'monitoring',
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
      id: 'monitoring.service',
      version: '1.0.0',
      owner: 'monitoring',
    },
  ],
  optionalCapabilities: ['host.notifications'],
  routes: [
    {
      operationId: 'getTaskQualityPolicy',
      method: 'GET',
      path: '/api/v2/tasks/{taskId}/quality-policy',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'updateTaskQualityPolicy',
      method: 'PUT',
      path: '/api/v2/tasks/{taskId}/quality-policy',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'getTaskHealth',
      method: 'GET',
      path: '/api/v2/tasks/{taskId}/health',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'listTaskQualityEvaluations',
      method: 'GET',
      path: '/api/v2/tasks/{taskId}/quality-evaluations',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'listTaskHealth',
      method: 'GET',
      path: '/api/v2/task-health',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'listTaskMonitoringAlerts',
      method: 'GET',
      path: '/api/v2/tasks/{taskId}/monitoring-alerts',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'listTaskMonitoringAlertRuns',
      method: 'GET',
      path: '/api/v2/tasks/{taskId}/monitoring-alerts/{alertId}/runs',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'dismissTaskMonitoringAlert',
      method: 'DELETE',
      path: '/api/v2/tasks/{taskId}/monitoring-alerts/{alertId}',
      requiredPermission: 'task.write',
    },
  ],
  events: [
    {
      type: 'quality.issue.detected',
      durable: true,
    },
    {
      type: 'quality.recovered',
      durable: true,
    },
    {
      type: 'monitoring.alert.created',
      durable: true,
    },
    {
      type: 'monitoring.alert.updated',
      durable: true,
    },
    {
      type: 'monitoring.alert.resolved',
      durable: true,
    },
    {
      type: 'monitoring.alert.deleted',
      durable: true,
    },
    {
      type: 'monitoring.notification.local',
      durable: true,
    },
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
  backgroundHandlers: [
    {
      type: 'monitoring.quality.evaluate',
      resourceClass: 'io',
    },
  ],
} as const satisfies PluginManifest;
export default monitoringPlugin;
