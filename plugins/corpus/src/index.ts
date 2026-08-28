import type { PluginDescriptor } from '@zhiyun/kernel';

export const corpusPlugin: PluginDescriptor = {
  id: 'corpus',
  version: '1.0.0',
  dependencies: [{ id: 'datasets', range: '^1.0.0' }],
  optionalCapabilities: ['analytics.worker', 'artifact.store'],
  routes: [
    { operationId: 'listCorpora', method: 'GET', path: '/api/v2/corpora' },
    { operationId: 'createCorpus', method: 'POST', path: '/api/v2/corpora' },
    { operationId: 'getCorpus', method: 'GET', path: '/api/v2/corpora/{corpusId}' },
    { operationId: 'updateCorpus', method: 'PUT', path: '/api/v2/corpora/{corpusId}' },
    { operationId: 'deleteCorpus', method: 'DELETE', path: '/api/v2/corpora/{corpusId}' },
    { operationId: 'listCorpusRecipes', method: 'GET', path: '/api/v2/corpora/{corpusId}/recipes' },
    {
      operationId: 'createCorpusRecipe',
      method: 'POST',
      path: '/api/v2/corpora/{corpusId}/recipes',
    },
    {
      operationId: 'updateCorpusRecipe',
      method: 'PUT',
      path: '/api/v2/corpora/{corpusId}/recipes/{recipeId}',
    },
    {
      operationId: 'deleteCorpusRecipe',
      method: 'DELETE',
      path: '/api/v2/corpora/{corpusId}/recipes/{recipeId}',
    },
    { operationId: 'createCorpusBuild', method: 'POST', path: '/api/v2/corpora/{corpusId}/builds' },
    { operationId: 'listCorpusBuilds', method: 'GET', path: '/api/v2/corpus-builds' },
    { operationId: 'getCorpusBuild', method: 'GET', path: '/api/v2/corpus-builds/{buildId}' },
    {
      operationId: 'cancelCorpusBuild',
      method: 'POST',
      path: '/api/v2/corpus-builds/{buildId}/cancel',
    },
    {
      operationId: 'retryCorpusBuild',
      method: 'POST',
      path: '/api/v2/corpus-builds/{buildId}/retry',
    },
    {
      operationId: 'listCorpusVersions',
      method: 'GET',
      path: '/api/v2/corpora/{corpusId}/versions',
    },
    {
      operationId: 'getCorpusVersion',
      method: 'GET',
      path: '/api/v2/corpora/{corpusId}/versions/{versionId}',
    },
    {
      operationId: 'exportCorpusVersion',
      method: 'POST',
      path: '/api/v2/corpora/{corpusId}/versions/{versionId}/exports',
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
