import { createServiceToken, type PluginDescriptor } from '@zhiyun/kernel';

export interface CollectionReadService {
  getTask(id: string): Promise<unknown | null>;
  getRun(id: string): Promise<unknown | null>;
}

export const collectionReadService = createServiceToken<CollectionReadService>(
  'collection.read',
  '1.0.0',
  'collection',
);

export const collectionPlugin: PluginDescriptor = {
  id: 'collection',
  version: '1.0.0',
  dependencies: [{ id: 'datasets', range: '^1.0.0' }],
  optionalCapabilities: ['crawler.engine', 'scheduler'],
  providedServices: [collectionReadService],
  routes: [
    { operationId: 'listTasks', method: 'GET', path: '/api/v2/tasks' },
    { operationId: 'createTask', method: 'POST', path: '/api/v2/tasks' },
    { operationId: 'getTask', method: 'GET', path: '/api/v2/tasks/{taskId}' },
    { operationId: 'updateTask', method: 'PUT', path: '/api/v2/tasks/{taskId}' },
    { operationId: 'createRun', method: 'POST', path: '/api/v2/tasks/{taskId}/runs' },
    { operationId: 'getRun', method: 'GET', path: '/api/v2/runs/{runId}' },
  ],
  events: [
    { type: 'collection.run.created', durable: true },
    { type: 'collection.run.succeeded', durable: true },
    { type: 'collection.run.failed', durable: true },
  ],
  migrations: [
    {
      id: '001-initial',
      tables: [
        'tasks',
        'rules',
        'rule_versions',
        'rule_repair_proposals',
        'runs',
        'run_logs',
        'run_requests',
        'task_schedules',
      ],
    },
  ],
  uiContributions: [
    { id: 'collection.tasks-route', kind: 'route' },
    { id: 'collection.navigation', kind: 'navigation' },
  ],
  backgroundHandlers: [{ type: 'collection.crawl.execute', resourceClass: 'browser-heavy' }],
  activate() {},
};
