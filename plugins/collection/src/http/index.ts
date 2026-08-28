import type { RouteContribution } from '@zhiyun/kernel';

export const collectionRoutes = [
  { operationId: 'listTasks', method: 'GET', path: '/api/v2/tasks' },
  { operationId: 'createTask', method: 'POST', path: '/api/v2/tasks' },
  { operationId: 'getTask', method: 'GET', path: '/api/v2/tasks/{taskId}' },
  { operationId: 'updateTask', method: 'PUT', path: '/api/v2/tasks/{taskId}' },
  { operationId: 'deleteTask', method: 'DELETE', path: '/api/v2/tasks/{taskId}' },
  { operationId: 'listRules', method: 'GET', path: '/api/v2/tasks/{taskId}/rules' },
  { operationId: 'createRule', method: 'POST', path: '/api/v2/tasks/{taskId}/rules' },
  { operationId: 'listRuns', method: 'GET', path: '/api/v2/tasks/{taskId}/runs' },
  { operationId: 'createRun', method: 'POST', path: '/api/v2/tasks/{taskId}/runs' },
  { operationId: 'getRun', method: 'GET', path: '/api/v2/runs/{runId}' },
  { operationId: 'cancelRun', method: 'POST', path: '/api/v2/runs/{runId}/cancel' },
  { operationId: 'listRunLogs', method: 'GET', path: '/api/v2/runs/{runId}/logs' },
  { operationId: 'listRunRequests', method: 'GET', path: '/api/v2/runs/{runId}/requests' },
] as const satisfies readonly RouteContribution[];
