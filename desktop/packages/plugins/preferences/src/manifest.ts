import type { PluginManifest } from '@zhiyun/plugin-runtime';
export const preferencesPlugin = {
  id: 'preferences',
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
      id: 'preferences.service',
      version: '1.0.0',
      owner: 'preferences',
    },
  ],
  routes: [
    {
      operationId: 'getPreferenceProfile',
      method: 'GET',
      path: '/api/v2/preferences/profile',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'listPreferenceSignals',
      method: 'GET',
      path: '/api/v2/preferences/signals',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'createPreferenceSignal',
      method: 'POST',
      path: '/api/v2/preferences/signals',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'deletePreferenceSignal',
      method: 'DELETE',
      path: '/api/v2/preferences/signals/{signalId}',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'clearPreferenceSignals',
      method: 'DELETE',
      path: '/api/v2/preferences/signals',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'listTrends',
      method: 'GET',
      path: '/api/v2/trends',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'listTrendSources',
      method: 'GET',
      path: '/api/v2/trend-sources',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'bootstrapTrendSources',
      method: 'POST',
      path: '/api/v2/trend-sources/bootstrap',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'updateTrendSource',
      method: 'PUT',
      path: '/api/v2/trend-sources/{sourceKey}',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'runTrendSource',
      method: 'POST',
      path: '/api/v2/trend-sources/{sourceKey}/run',
      requiredPermission: 'run.execute',
    },
    {
      operationId: 'runTrendSources',
      method: 'POST',
      path: '/api/v2/trend-sources/run',
      requiredPermission: 'run.execute',
    },
    {
      operationId: 'importPreference',
      method: 'POST',
      path: '/api/v2/preferences/import',
      requiredPermission: 'task.write',
    },
  ],
  events: [
    {
      type: 'preferences.signal.updated',
      durable: true,
    },
    {
      type: 'preferences.trend-source.updated',
      durable: true,
    },
  ],
  migrations: [
    {
      id: '001-initial',
      tables: ['trend_sources', 'preference_signals'],
    },
  ],
  uiContributions: [
    {
      id: 'preferences.route',
      kind: 'route',
    },
    {
      id: 'preferences.navigation',
      kind: 'navigation',
    },
  ],
} as const satisfies PluginManifest;
export default preferencesPlugin;
