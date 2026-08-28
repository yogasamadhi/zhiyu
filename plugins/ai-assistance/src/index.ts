import type { PluginDescriptor } from '@zhiyun/kernel';

export const aiAssistancePlugin: PluginDescriptor = {
  id: 'ai-assistance',
  version: '1.0.0',
  dependencies: [{ id: 'collection', range: '^1.0.0' }],
  optionalCapabilities: ['ai.provider'],
  routes: [
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
  ],
  events: [{ type: 'ai.request.completed', durable: true }],
  activate() {},
};
