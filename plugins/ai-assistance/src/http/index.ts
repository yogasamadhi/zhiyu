import type { RouteContribution } from '@zhiyun/kernel';

export const aiAssistanceRoutes = [
  {
    operationId: 'analyzeTaskRule',
    method: 'POST',
    path: '/api/v2/tasks/{taskId}/rule-analysis',
  },
  {
    operationId: 'explainRunFailure',
    method: 'POST',
    path: '/api/v2/runs/{runId}/explain-failure',
  },
] as const satisfies readonly RouteContribution[];
