import type { PluginDescriptor } from '@zhiyun/kernel';

export const preferencesPlugin: PluginDescriptor = {
  id: 'preferences',
  version: '1.0.0',
  dependencies: [
    { id: 'collection', range: '^1.0.0' },
    { id: 'datasets', range: '^1.0.0' },
  ],
  routes: [
    { operationId: 'getPreferenceProfile', method: 'GET', path: '/api/v2/preferences/profile' },
    { operationId: 'listPreferenceSignals', method: 'GET', path: '/api/v2/preferences/signals' },
    { operationId: 'listTrends', method: 'GET', path: '/api/v2/trends' },
  ],
  events: [{ type: 'preferences.signal.updated', durable: true }],
  migrations: [{ id: '001-initial', tables: ['trend_sources', 'preference_signals'] }],
  uiContributions: [
    { id: 'preferences.route', kind: 'route' },
    { id: 'preferences.navigation', kind: 'navigation' },
  ],
  activate() {},
};
