import { createServiceToken, type PluginDescriptor } from '@zhiyun/kernel';
import type { PreferencesServiceContract } from './contracts/index.js';
import { preferencesRoutes } from './http/index.js';
import { preferencesUiContributions } from './ui/index.js';

export const preferencesService = createServiceToken<PreferencesServiceContract>(
  'preferences.service',
  '1.0.0',
  'preferences',
);

export const preferencesPlugin: PluginDescriptor = {
  id: 'preferences',
  version: '1.0.0',
  dependencies: [
    { id: 'collection', range: '^1.0.0' },
    { id: 'datasets', range: '^1.0.0' },
  ],
  providedServices: [preferencesService],
  routes: preferencesRoutes,
  events: [
    { type: 'preferences.signal.updated', durable: true },
    { type: 'preferences.trend-source.updated', durable: true },
  ],
  migrations: [{ id: '001-initial', tables: ['trend_sources', 'preference_signals'] }],
  uiContributions: preferencesUiContributions,
  activate() {},
};

export * from './application/index.js';
export * from './contracts/index.js';
export * from './domain/index.js';
export * from './http/index.js';
export * from './persistence/sqlite/index.js';
export * from './ui/index.js';
