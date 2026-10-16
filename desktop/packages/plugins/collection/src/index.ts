export { collectionPlugin } from './manifest.js';
export { apply, Config, default, inject } from './plugin.js';
import type { CrawlRun } from '@zhiyun/shared';
import type { CollectionTaskDetail } from './contracts/index.js';

export interface CollectionReadService {
  getTask(id: string): Promise<CollectionTaskDetail | null>;
  getRun(id: string): Promise<CrawlRun | null>;
}

export * from './application/index.js';
export * from './contracts/index.js';
export * from './domain/index.js';
export * from './http/index.js';
export * from './persistence/sqlite/index.js';
export * from './ui/index.js';

export { executeProductExample, productExampleDraft } from './domain/example.js';
export { commitCanonicalDraft, draftFingerprint } from './http/drafts.js';
