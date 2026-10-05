import type { BrowserActionCacheSummary, CrawlPlanDefinition, TaskUpdate } from './index.js';
import type { CollectionPreviewRecord } from './collection-preview.js';
export interface CollectionDraft {
  id: string;
  revision: number;
  taskId: string | null;
  taskRevision: number | null;
  exampleId: 'products' | null;
  step: 1 | 2 | 3;
  mode: 'manual' | 'ai' | 'template';
  task: TaskUpdate;
  definition: CrawlPlanDefinition | null;
  preview: {
    fingerprint: string;
    records: CollectionPreviewRecord[];
    createdAt: string;
    actionCache?: BrowserActionCacheSummary;
  } | null;
  status: 'editing' | 'committing' | 'committed';
  commitRun: boolean | null;
  result: { taskId: string; runId: string | null } | null;
  createdAt: string;
  updatedAt: string;
}
export type CollectionDraftPatch = Partial<
  Pick<CollectionDraft, 'step' | 'mode' | 'task' | 'definition'>
>;
