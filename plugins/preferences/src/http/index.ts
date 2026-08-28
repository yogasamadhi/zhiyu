import type { RouteContribution } from '@zhiyun/kernel';

export const preferencesRoutes = [
  { operationId: 'getPreferenceProfile', method: 'GET', path: '/api/v2/preferences/profile' },
  { operationId: 'listPreferenceSignals', method: 'GET', path: '/api/v2/preferences/signals' },
  { operationId: 'createPreferenceSignal', method: 'POST', path: '/api/v2/preferences/signals' },
  {
    operationId: 'deletePreferenceSignal',
    method: 'DELETE',
    path: '/api/v2/preferences/signals/{signalId}',
  },
  {
    operationId: 'clearPreferenceSignals',
    method: 'DELETE',
    path: '/api/v2/preferences/signals',
  },
  { operationId: 'listTrends', method: 'GET', path: '/api/v2/trends' },
] as const satisfies readonly RouteContribution[];
