import { createServiceToken, type PluginDescriptor } from '@zhiyun/kernel';
import type { Dataset, DatasetCommitInput, DatasetCommitResult } from './contracts/index.js';
import { datasetsRoutes } from './http/index.js';
import { datasetsUiContributions } from './ui/index.js';

export interface DatasetReadService {
  getDataset(id: string): Promise<Dataset | null>;
}

export interface DatasetSnapshotContract {
  createSnapshot(datasetId: string): Promise<{ id: string; fingerprint: string }>;
}

export interface DatasetIngestionService {
  commitRunRecords(input: DatasetCommitInput): Promise<DatasetCommitResult>;
}

export const datasetReadService = createServiceToken<DatasetReadService>(
  'datasets.read',
  '1.0.0',
  'datasets',
);
export const datasetSnapshotService = createServiceToken<DatasetSnapshotContract>(
  'datasets.snapshot',
  '1.0.0',
  'datasets',
);
export const datasetIngestionService = createServiceToken<DatasetIngestionService>(
  'datasets.ingestion',
  '1.0.0',
  'datasets',
);

export const datasetsPlugin: PluginDescriptor = {
  id: 'datasets',
  version: '1.0.0',
  optionalCapabilities: ['artifact.store'],
  providedServices: [datasetReadService, datasetSnapshotService, datasetIngestionService],
  routes: datasetsRoutes,
  events: [
    { type: 'dataset.projected', durable: true },
    { type: 'dataset.snapshot.ready', durable: true },
  ],
  migrations: [
    {
      id: '001-initial',
      tables: ['records', 'datasets', 'dataset_records', 'record_changes', 'dataset_snapshots'],
    },
    { id: '002-data-query', tables: [] },
    {
      id: '003-batch-ingestion',
      tables: [
        'dataset_ingestions',
        'dataset_ingestion_batches',
        'dataset_ingestion_seen',
        'dataset_ingestion_records',
      ],
    },
    {
      id: '004-cleaning',
      tables: [
        'dataset_cleaning_recipes',
        'dataset_cleaning_recipe_versions',
        'dataset_cleaning_sessions',
      ],
    },
  ],
  uiContributions: datasetsUiContributions,
  backgroundHandlers: [{ type: 'datasets.snapshot.prepare', resourceClass: 'io' }],
  activate() {},
};

export * from './application/index.js';
export * from './application/cleaning.js';
export * from './contracts/index.js';
export * from './domain/index.js';
export * from './http/index.js';
export * from './persistence/sqlite/index.js';
export * from './persistence/sqlite/cleaning.js';
export * from './ui/index.js';
