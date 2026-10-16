import type { PluginManifest } from '@zhiyun/plugin-runtime';
export const datasetsPlugin = {
  id: 'datasets',
  version: '1.0.0',
  optionalCapabilities: ['artifact.store'],
  providedServices: [
    {
      id: 'datasets.read',
      version: '1.0.0',
      owner: 'datasets',
    },
    {
      id: 'datasets.snapshot',
      version: '1.0.0',
      owner: 'datasets',
    },
    {
      id: 'datasets.ingestion',
      version: '1.0.0',
      owner: 'datasets',
    },
  ],
  routes: [
    {
      operationId: 'previewDatasetCleaning',
      method: 'POST',
      path: '/api/v2/datasets/{datasetId}/cleaning/preview',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'saveDatasetCleaningRecipe',
      method: 'POST',
      path: '/api/v2/datasets/{datasetId}/cleaning/recipes',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'listDatasetCleaningRecipes',
      method: 'GET',
      path: '/api/v2/datasets/{datasetId}/cleaning/recipes',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'getDatasetCleaningRecipe',
      method: 'GET',
      path: '/api/v2/datasets/{datasetId}/cleaning/recipes/{recipeId}',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'applyDatasetCleaning',
      method: 'POST',
      path: '/api/v2/datasets/{datasetId}/cleaning/sessions',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'listDatasetCleaningSessions',
      method: 'GET',
      path: '/api/v2/datasets/{datasetId}/cleaning/sessions',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'getDatasetCleaningSession',
      method: 'GET',
      path: '/api/v2/datasets/{datasetId}/cleaning/sessions/{sessionId}',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'selectDatasetCleaningStep',
      method: 'POST',
      path: '/api/v2/datasets/{datasetId}/cleaning/sessions/{sessionId}/selection',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'getDatasetFields',
      method: 'GET',
      path: '/api/v2/datasets/{datasetId}/fields',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'listDatasets',
      method: 'GET',
      path: '/api/v2/datasets',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'getDataset',
      method: 'GET',
      path: '/api/v2/datasets/{datasetId}',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'listDatasetRecords',
      method: 'GET',
      path: '/api/v2/datasets/{datasetId}/records',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'listDatasetChanges',
      method: 'GET',
      path: '/api/v2/datasets/{datasetId}/changes',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'diffDataset',
      method: 'GET',
      path: '/api/v2/datasets/{datasetId}/diff',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'exportDataset',
      method: 'POST',
      path: '/api/v2/datasets/{datasetId}/exports',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'createDatasetSnapshot',
      method: 'POST',
      path: '/api/v2/datasets/{datasetId}/snapshots',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'listDatasetSnapshots',
      method: 'GET',
      path: '/api/v2/datasets/{datasetId}/snapshots',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'getDatasetSnapshot',
      method: 'GET',
      path: '/api/v2/datasets/{datasetId}/snapshots/{snapshotId}',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'listRunRecords',
      method: 'GET',
      path: '/api/v2/runs/{runId}/records',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'exportRunRecords',
      method: 'POST',
      path: '/api/v2/runs/{runId}/exports',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'queryDataApiRecords',
      method: 'GET',
      path: '/api/v2/data/tasks/{taskId}/records',
      requiredPermission: 'workspace.read',
    },
  ],
  events: [
    {
      type: 'dataset.projected',
      durable: true,
    },
    {
      type: 'dataset.snapshot.ready',
      durable: true,
    },
  ],
  migrations: [
    {
      id: '001-initial',
      tables: ['records', 'datasets', 'dataset_records', 'record_changes', 'dataset_snapshots'],
    },
    {
      id: '002-data-query',
      tables: [],
    },
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
  uiContributions: [
    {
      id: 'datasets.navigation',
      kind: 'navigation',
    },
    {
      id: 'datasets.route',
      kind: 'route',
    },
    {
      id: 'datasets.task-panel',
      kind: 'panel',
    },
  ],
  backgroundHandlers: [
    {
      type: 'datasets.snapshot.prepare',
      resourceClass: 'io',
    },
  ],
} as const satisfies PluginManifest;
export default datasetsPlugin;
