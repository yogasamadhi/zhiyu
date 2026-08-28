import type { PluginDescriptor } from '@zhiyun/kernel';

export const analyticsPlugin: PluginDescriptor = {
  id: 'analytics',
  version: '1.0.0',
  dependencies: [{ id: 'datasets', range: '^1.0.0' }],
  optionalCapabilities: ['analytics.worker', 'artifact.store'],
  routes: [
    { operationId: 'listAnalysisMethods', method: 'GET', path: '/api/v2/analytics/methods' },
    { operationId: 'listAnalysisRecipes', method: 'GET', path: '/api/v2/analytics/recipes' },
    { operationId: 'createAnalysisRecipe', method: 'POST', path: '/api/v2/analytics/recipes' },
    { operationId: 'listAnalysisJobs', method: 'GET', path: '/api/v2/analytics/jobs' },
    { operationId: 'createAnalysisJob', method: 'POST', path: '/api/v2/analytics/jobs' },
    {
      operationId: 'getAnalysisResult',
      method: 'GET',
      path: '/api/v2/analytics/results/{resultId}',
    },
  ],
  events: [
    { type: 'analysis.job.created', durable: true },
    { type: 'analysis.job.started', durable: true },
    { type: 'analysis.job.succeeded', durable: true },
    { type: 'analysis.job.failed', durable: true },
    { type: 'analysis.job.canceled', durable: true },
  ],
  migrations: [
    {
      id: '001-initial',
      tables: ['analysis_recipes', 'analysis_jobs', 'analysis_results', 'analysis_artifacts'],
    },
  ],
  uiContributions: [
    { id: 'analytics.route', kind: 'route' },
    { id: 'analytics.navigation', kind: 'navigation' },
    { id: 'analytics.dataset-panel', kind: 'panel' },
  ],
  backgroundHandlers: [{ type: 'analytics.job.execute', resourceClass: 'python-heavy' }],
  activate() {},
};
