import type { RouteContribution } from '@zhiyun/kernel';

export const datasetsRoutes = [
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
    operationId: 'diffDataset',
    method: 'GET',
    path: '/api/v2/datasets/{datasetId}/diff',
  },
  {
    operationId: 'exportDataset',
    method: 'POST',
    path: '/api/v2/datasets/{datasetId}/exports',
  },
  {
    operationId: 'createDatasetSnapshot',
    method: 'POST',
    path: '/api/v2/datasets/{datasetId}/snapshots',
  },
  {
    operationId: 'getDatasetSnapshot',
    method: 'GET',
    path: '/api/v2/datasets/{datasetId}/snapshots/{snapshotId}',
  },
] as const satisfies readonly RouteContribution[];
