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
    { operationId: 'createCorpusBuild', method: 'POST', path: '/api/v2/corpora/{corpusId}/builds' },
    { operationId: 'getCorpusBuild', method: 'GET', path: '/api/v2/corpus-builds/{buildId}' },
  ],
  events: [
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
