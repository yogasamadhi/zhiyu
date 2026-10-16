import type { PluginManifest } from '@zhiyun/plugin-runtime';
export const analyticsPlugin = {
  id: 'analytics',
  version: '1.0.0',
  dependencies: [
    {
      id: 'datasets',
      range: '^1.0.0',
    },
  ],
  optionalCapabilities: ['analytics.worker', 'artifact.store'],
  providedServices: [
    {
      id: 'analytics.catalog',
      version: '1.0.0',
      owner: 'analytics',
    },
  ],
  routes: [
    {
      operationId: 'listAnalysisMethods',
      method: 'GET',
      path: '/api/v2/analytics/methods',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'listAnalysisRecipes',
      method: 'GET',
      path: '/api/v2/analytics/recipes',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'createAnalysisRecipe',
      method: 'POST',
      path: '/api/v2/analytics/recipes',
      requiredPermission: 'analysis.write',
    },
    {
      operationId: 'getAnalysisRecipe',
      method: 'GET',
      path: '/api/v2/analytics/recipes/{recipeId}',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'updateAnalysisRecipe',
      method: 'PUT',
      path: '/api/v2/analytics/recipes/{recipeId}',
      requiredPermission: 'analysis.write',
    },
    {
      operationId: 'deleteAnalysisRecipe',
      method: 'DELETE',
      path: '/api/v2/analytics/recipes/{recipeId}',
      requiredPermission: 'analysis.write',
    },
    {
      operationId: 'listAnalysisJobs',
      method: 'GET',
      path: '/api/v2/analytics/jobs',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'createAnalysisJob',
      method: 'POST',
      path: '/api/v2/analytics/jobs',
      requiredPermission: 'analysis.write',
    },
    {
      operationId: 'getAnalysisJob',
      method: 'GET',
      path: '/api/v2/analytics/jobs/{jobId}',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'cancelAnalysisJob',
      method: 'POST',
      path: '/api/v2/analytics/jobs/{jobId}/cancel',
      requiredPermission: 'analysis.write',
    },
    {
      operationId: 'retryAnalysisJob',
      method: 'POST',
      path: '/api/v2/analytics/jobs/{jobId}/retry',
      requiredPermission: 'analysis.write',
    },
    {
      operationId: 'getAnalysisResult',
      method: 'GET',
      path: '/api/v2/analytics/results/{resultId}',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'getAnalysisResultPage',
      method: 'GET',
      path: '/api/v2/analytics/results/{resultId}/collections/{section}/{collectionId}',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'branchAnalysisResult',
      method: 'POST',
      path: '/api/v2/analytics/results/{resultId}/branches',
      requiredPermission: 'analysis.write',
    },
    {
      operationId: 'compareAnalysisResults',
      method: 'GET',
      path: '/api/v2/analytics/results/{leftId}/compare/{rightId}',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'exportAnalysisResult',
      method: 'POST',
      path: '/api/v2/analytics/results/{resultId}/exports',
      requiredPermission: 'workspace.read',
    },
  ],
  events: [
    {
      type: 'analysis.recipe.created',
      durable: true,
    },
    {
      type: 'analysis.recipe.updated',
      durable: true,
    },
    {
      type: 'analysis.recipe.deleted',
      durable: true,
    },
    {
      type: 'analysis.job.created',
      durable: true,
    },
    {
      type: 'analysis.job.started',
      durable: true,
    },
    {
      type: 'analysis.job.succeeded',
      durable: true,
    },
    {
      type: 'analysis.job.failed',
      durable: true,
    },
    {
      type: 'analysis.job.canceled',
      durable: true,
    },
  ],
  migrations: [
    {
      id: '001-initial',
      tables: ['analysis_recipes', 'analysis_jobs', 'analysis_results', 'analysis_artifacts'],
    },
    {
      id: '002-result-lineage',
      tables: ['analysis_result_collections', 'analysis_result_rows'],
    },
  ],
  uiContributions: [
    {
      id: 'analytics.route',
      kind: 'route',
    },
    {
      id: 'analytics.navigation',
      kind: 'navigation',
    },
    {
      id: 'analytics.dataset-panel',
      kind: 'panel',
    },
  ],
  backgroundHandlers: [
    {
      type: 'analytics.job.execute',
      resourceClass: 'python-heavy',
    },
  ],
} as const satisfies PluginManifest;
export default analyticsPlugin;
