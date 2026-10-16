import type { PluginManifest } from '@zhiyun/plugin-runtime';
export const collectionPlugin = {
  id: 'collection',
  version: '1.0.0',
  dependencies: [
    {
      id: 'datasets',
      range: '^1.0.0',
    },
  ],
  optionalCapabilities: ['crawler.engine', 'scheduler'],
  providedServices: [
    {
      id: 'collection.read',
      version: '1.0.0',
      owner: 'collection',
    },
    {
      id: 'collection.services',
      version: '1.0.0',
      owner: 'collection',
    },
  ],
  routes: [
    {
      operationId: 'startDraftLoginSession',
      method: 'POST',
      path: '/api/v2/collection-drafts/{draftId}/browser-session/login',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'listCollectionDrafts',
      method: 'GET',
      path: '/api/v2/collection-drafts',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'createCollectionDraft',
      method: 'POST',
      path: '/api/v2/collection-drafts',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'getCollectionDraft',
      method: 'GET',
      path: '/api/v2/collection-drafts/{draftId}',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'updateCollectionDraft',
      method: 'PATCH',
      path: '/api/v2/collection-drafts/{draftId}',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'deleteCollectionDraft',
      method: 'DELETE',
      path: '/api/v2/collection-drafts/{draftId}',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'previewCollectionDraft',
      method: 'POST',
      path: '/api/v2/collection-drafts/{draftId}/preview',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'commitCollectionDraft',
      method: 'POST',
      path: '/api/v2/collection-drafts/{draftId}/commit',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'createExampleDraft',
      method: 'POST',
      path: '/api/v2/examples/{exampleId}/drafts',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'previewSchedule',
      method: 'POST',
      path: '/api/v2/schedules/preview',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'previewInitialRule',
      method: 'POST',
      path: '/api/v2/rules/preview',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'createTaskWithInitialRule',
      method: 'POST',
      path: '/api/v2/tasks/initialize',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'listTasks',
      method: 'GET',
      path: '/api/v2/tasks',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'createTask',
      method: 'POST',
      path: '/api/v2/tasks',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'getTask',
      method: 'GET',
      path: '/api/v2/tasks/{taskId}',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'updateTask',
      method: 'PUT',
      path: '/api/v2/tasks/{taskId}',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'deleteTask',
      method: 'DELETE',
      path: '/api/v2/tasks/{taskId}',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'listRules',
      method: 'GET',
      path: '/api/v2/tasks/{taskId}/rules',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'testRule',
      method: 'POST',
      path: '/api/v2/tasks/{taskId}/rules/test',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'createRule',
      method: 'POST',
      path: '/api/v2/tasks/{taskId}/rules',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'createRuleVersion',
      method: 'POST',
      path: '/api/v2/tasks/{taskId}/rules/{ruleId}/versions',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'diffRuleVersions',
      method: 'GET',
      path: '/api/v2/tasks/{taskId}/rules/{ruleId}/diff',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'rollbackRuleVersion',
      method: 'POST',
      path: '/api/v2/tasks/{taskId}/rules/{ruleId}/rollback',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'listRuleRepairProposals',
      method: 'GET',
      path: '/api/v2/tasks/{taskId}/rules/{ruleId}/repair-proposals',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'startTaskLoginSession',
      method: 'POST',
      path: '/api/v2/tasks/{taskId}/browser-session/login',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'promptTaskCredential',
      method: 'POST',
      path: '/api/v2/tasks/{taskId}/credentials/{kind}',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'deleteTaskCredential',
      method: 'DELETE',
      path: '/api/v2/tasks/{taskId}/credentials/{kind}',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'listRuns',
      method: 'GET',
      path: '/api/v2/tasks/{taskId}/runs',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'createRun',
      method: 'POST',
      path: '/api/v2/tasks/{taskId}/runs',
      requiredPermission: 'run.execute',
    },
    {
      operationId: 'getRun',
      method: 'GET',
      path: '/api/v2/runs/{runId}',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'cancelRun',
      method: 'POST',
      path: '/api/v2/runs/{runId}/cancel',
      requiredPermission: 'run.execute',
    },
    {
      operationId: 'retryRun',
      method: 'POST',
      path: '/api/v2/runs/{runId}/retry',
      requiredPermission: 'run.execute',
    },
    {
      operationId: 'listRunLogs',
      method: 'GET',
      path: '/api/v2/runs/{runId}/logs',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'listRunRequests',
      method: 'GET',
      path: '/api/v2/runs/{runId}/requests',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'getRunDiagnostics',
      method: 'GET',
      path: '/api/v2/runs/{runId}/diagnostics',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'clearRunDiagnostics',
      method: 'DELETE',
      path: '/api/v2/runs/{runId}/diagnostics',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'createInspectionSession',
      method: 'POST',
      path: '/api/v2/inspection-sessions',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'getInspectionScreenshot',
      method: 'GET',
      path: '/api/v2/inspection-sessions/{sessionId}/screenshot',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'interactWithInspection',
      method: 'POST',
      path: '/api/v2/inspection-sessions/{sessionId}/actions',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'selectInspectionElement',
      method: 'POST',
      path: '/api/v2/inspection-sessions/{sessionId}/select',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'closeInspectionSession',
      method: 'DELETE',
      path: '/api/v2/inspection-sessions/{sessionId}',
      requiredPermission: 'task.write',
    },
  ],
  events: [
    {
      type: 'collection.task.created',
      durable: true,
    },
    {
      type: 'collection.task.updated',
      durable: true,
    },
    {
      type: 'collection.task.deleted',
      durable: true,
    },
    {
      type: 'collection.rule.created',
      durable: true,
    },
    {
      type: 'collection.rule.version-created',
      durable: true,
    },
    {
      type: 'collection.run.queued',
      durable: true,
    },
    {
      type: 'collection.run.started',
      durable: true,
    },
    {
      type: 'collection.run.succeeded',
      durable: true,
    },
    {
      type: 'collection.run.failed',
      durable: true,
    },
    {
      type: 'collection.run.cancel-requested',
      durable: true,
    },
    {
      type: 'collection.run.canceled',
      durable: true,
    },
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
    {
      id: '002-task-origin',
      tables: [],
    },
    {
      id: '003-unified-drafts',
      tables: ['collection_drafts'],
    },
    {
      id: '004-crawl-batches',
      tables: ['collection_crawl_sessions', 'collection_crawl_batches'],
    },
    {
      id: '005-url-checkpoints',
      tables: ['collection_crawl_requests'],
    },
    {
      id: '006-sitemap-spool',
      tables: [
        'collection_crawl_sitemap_nodes',
        'collection_crawl_sitemap_entries',
        'collection_crawl_sitemap_batches',
      ],
    },
    {
      id: '007-crawl-cleanup',
      tables: ['collection_crawl_cleanup'],
    },
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
  uiContributions: [
    {
      id: 'collection.scenarios-navigation',
      kind: 'navigation',
    },
    {
      id: 'collection.route',
      kind: 'route',
    },
    {
      id: 'collection.navigation',
      kind: 'navigation',
    },
    {
      id: 'collection.run-panel',
      kind: 'panel',
    },
  ],
  backgroundHandlers: [
    {
      type: 'collection.crawl.execute',
      resourceClass: 'browser-heavy',
    },
  ],
} as const satisfies PluginManifest;
export default collectionPlugin;
