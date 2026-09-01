import type { PluginDescriptor } from '@zhiyun/kernel';

export const corpusPlugin: PluginDescriptor = {
  id: 'corpus',
  version: '1.0.0',
  dependencies: [{ id: 'datasets', range: '^1.0.0' }],
  optionalCapabilities: ['analytics.worker', 'artifact.store'],
  routes: [
    {
      operationId: 'listCorpora',
      method: 'GET',
      path: '/api/v2/corpora',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'createCorpus',
      method: 'POST',
      path: '/api/v2/corpora',
      requiredPermission: 'analysis.write',
    },
    {
      operationId: 'getCorpus',
      method: 'GET',
      path: '/api/v2/corpora/{corpusId}',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'updateCorpus',
      method: 'PUT',
      path: '/api/v2/corpora/{corpusId}',
      requiredPermission: 'analysis.write',
    },
    {
      operationId: 'deleteCorpus',
      method: 'DELETE',
      path: '/api/v2/corpora/{corpusId}',
      requiredPermission: 'analysis.write',
    },
    {
      operationId: 'listCorpusRecipes',
      method: 'GET',
      path: '/api/v2/corpora/{corpusId}/recipes',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'createCorpusRecipe',
      method: 'POST',
      path: '/api/v2/corpora/{corpusId}/recipes',
      requiredPermission: 'analysis.write',
    },
    {
      operationId: 'updateCorpusRecipe',
      method: 'PUT',
      path: '/api/v2/corpora/{corpusId}/recipes/{recipeId}',
      requiredPermission: 'analysis.write',
    },
    {
      operationId: 'deleteCorpusRecipe',
      method: 'DELETE',
      path: '/api/v2/corpora/{corpusId}/recipes/{recipeId}',
      requiredPermission: 'analysis.write',
    },
    {
      operationId: 'createCorpusBuild',
      method: 'POST',
      path: '/api/v2/corpora/{corpusId}/builds',
      requiredPermission: 'analysis.write',
    },
    {
      operationId: 'listCorpusBuilds',
      method: 'GET',
      path: '/api/v2/corpus-builds',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'getCorpusBuild',
      method: 'GET',
      path: '/api/v2/corpus-builds/{buildId}',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'cancelCorpusBuild',
      method: 'POST',
      path: '/api/v2/corpus-builds/{buildId}/cancel',
      requiredPermission: 'analysis.write',
    },
    {
      operationId: 'retryCorpusBuild',
      method: 'POST',
      path: '/api/v2/corpus-builds/{buildId}/retry',
      requiredPermission: 'analysis.write',
    },
    {
      operationId: 'listCorpusVersions',
      method: 'GET',
      path: '/api/v2/corpora/{corpusId}/versions',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'getCorpusVersion',
      method: 'GET',
      path: '/api/v2/corpora/{corpusId}/versions/{versionId}',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'exportCorpusVersion',
      method: 'POST',
      path: '/api/v2/corpora/{corpusId}/versions/{versionId}/exports',
      requiredPermission: 'workspace.read',
    },
  ],
  events: [
    { type: 'corpus.created', durable: true },
    { type: 'corpus.updated', durable: true },
    { type: 'corpus.deleted', durable: true },
    { type: 'corpus.recipe.created', durable: true },
    { type: 'corpus.recipe.updated', durable: true },
    { type: 'corpus.recipe.deleted', durable: true },
    { type: 'corpus.build.created', durable: true },
    { type: 'corpus.build.started', durable: true },
    { type: 'corpus.version.created', durable: true },
    { type: 'corpus.build.failed', durable: true },
    { type: 'corpus.build.canceled', durable: true },
  ],
  migrations: [
    {
      id: '001-initial',
      tables: ['corpora', 'corpus_recipes', 'corpus_builds', 'corpus_versions', 'corpus_artifacts'],
    },
  ],
  uiContributions: [
    { id: 'corpus.route', kind: 'route' },
    { id: 'corpus.navigation', kind: 'navigation' },
    { id: 'corpus.dataset-panel', kind: 'panel' },
  ],
  backgroundHandlers: [{ type: 'corpus.build.execute', resourceClass: 'python-heavy' }],
  activate() {},
};

export * from './application/index.js';
export * from './contracts/index.js';
export * from './http/index.js';
export * from './migrations/postgres/index.js';
export * from './migrations/sqlite/index.js';
export * from './persistence/postgres/index.js';
export * from './persistence/sqlite/index.js';
