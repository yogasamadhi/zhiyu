import { createServiceToken, type PluginDescriptor } from '@zhiyun/kernel';

export interface DatasetReadService {
  getDataset(id: string): Promise<unknown | null>;
}

export interface DatasetSnapshotService {
  createSnapshot(datasetId: string): Promise<{ id: string; fingerprint: string }>;
}

export const datasetReadService = createServiceToken<DatasetReadService>(
  'datasets.read',
  '1.0.0',
  'datasets',
);
export const datasetSnapshotService = createServiceToken<DatasetSnapshotService>(
  'datasets.snapshot',
  '1.0.0',
  'datasets',
);

export const datasetsPlugin: PluginDescriptor = {
  id: 'datasets',
  version: '1.0.0',
  optionalCapabilities: ['artifact.store'],
  providedServices: [datasetReadService, datasetSnapshotService],
  routes: [
    { operationId: 'listDatasets', method: 'GET', path: '/api/v2/datasets' },
    { operationId: 'getDataset', method: 'GET', path: '/api/v2/datasets/{datasetId}' },
    {
      operationId: 'listDatasetRecords',
      method: 'GET',
      path: '/api/v2/datasets/{datasetId}/records',
    },
    {
      operationId: 'listDatasetChanges',
      method: 'GET',
      path: '/api/v2/datasets/{datasetId}/changes',
    },
    {
      operationId: 'createDatasetSnapshot',
      method: 'POST',
      path: '/api/v2/datasets/{datasetId}/snapshots',
    },
  ],
  events: [
    { type: 'dataset.projected', durable: true },
    { type: 'dataset.snapshot.created', durable: true },
  ],
  migrations: [
    {
      id: '001-initial',
      tables: ['records', 'datasets', 'dataset_records', 'record_changes', 'dataset_snapshots'],
    },
  ],
  uiContributions: [
    { id: 'datasets.route', kind: 'route' },
    { id: 'datasets.task-panel', kind: 'panel' },
  ],
  backgroundHandlers: [{ type: 'datasets.snapshot.prepare', resourceClass: 'io' }],
  activate() {},
};
