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
    { id: '002-task-origin', tables: [] },
    { id: '003-unified-drafts', tables: ['collection_drafts'] },
    { id: '004-crawl-batches', tables: ['collection_crawl_sessions', 'collection_crawl_batches'] },
    { id: '005-url-checkpoints', tables: ['collection_crawl_requests'] },
    {
      id: '006-sitemap-spool',
      tables: [
        'collection_crawl_sitemap_nodes',
        'collection_crawl_sitemap_entries',
        'collection_crawl_sitemap_batches',
      ],
    },
    { id: '007-crawl-cleanup', tables: ['collection_crawl_cleanup'] },
    {
      id: '008-browser-rounds',
      tables: [
        'collection_crawl_browser_rounds',
        'collection_crawl_browser_selected',
        'collection_crawl_browser_observed',
        'collection_crawl_browser_seen',
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
export * from './persistence/sqlite/index.js';
export * from './ui/index.js';

export { commitCanonicalDraft, draftFingerprint } from './http/drafts.js';
export { executeProductExample, productExampleDraft } from './domain/example.js';
