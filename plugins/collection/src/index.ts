import { createServiceToken, type PluginDescriptor } from '@zhiyun/kernel';
import type { CrawlRun } from '@zhiyun/shared';
import type { CollectionServiceContract, CollectionTaskDetail } from './contracts/index.js';
import { collectionRoutes } from './http/index.js';
import { collectionUiContributions } from './ui/index.js';

export interface CollectionReadService {
  getTask(id: string): Promise<CollectionTaskDetail | null>;
  getRun(id: string): Promise<CrawlRun | null>;
}

export const collectionReadService = createServiceToken<CollectionReadService>(
  'collection.read',
  '1.0.0',
  'collection',
);
export const collectionService = createServiceToken<CollectionServiceContract>(
  'collection.services',
  '1.0.0',
  'collection',
);

export const collectionPlugin: PluginDescriptor = {
  id: 'collection',
  version: '1.0.0',
  dependencies: [{ id: 'datasets', range: '^1.0.0' }],
  optionalCapabilities: ['crawler.engine', 'scheduler'],
  providedServices: [collectionReadService, collectionService],
  routes: collectionRoutes,
  events: [
    { type: 'collection.task.created', durable: true },
    { type: 'collection.task.updated', durable: true },
    { type: 'collection.task.deleted', durable: true },
    { type: 'collection.rule.created', durable: true },
    { type: 'collection.rule.version-created', durable: true },
    { type: 'collection.run.queued', durable: true },
    { type: 'collection.run.started', durable: true },
    { type: 'collection.run.succeeded', durable: true },
    { type: 'collection.run.failed', durable: true },
    { type: 'collection.run.cancel-requested', durable: true },
    { type: 'collection.run.canceled', durable: true },
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
  uiContributions: collectionUiContributions,
  backgroundHandlers: [{ type: 'collection.crawl.execute', resourceClass: 'browser-heavy' }],
  activate() {},
};

export * from './application/index.js';
export * from './contracts/index.js';
export * from './domain/index.js';
export * from './http/index.js';
export * from './persistence/postgres/index.js';
export * from './persistence/sqlite/index.js';
export * from './ui/index.js';
