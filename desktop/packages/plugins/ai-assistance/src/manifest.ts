import type { PluginManifest } from '@zhiyun/plugin-runtime';
export const aiAssistancePlugin = {
  id: 'ai-assistance',
  version: '1.0.0',
  dependencies: [
    {
      id: 'collection',
      range: '^1.0.0',
    },
  ],
  optionalCapabilities: ['ai.provider'],
  providedServices: [
    {
      id: 'ai-assistance.service',
      version: '1.0.0',
      owner: 'ai-assistance',
    },
  ],
  routes: [
    {
      method: 'GET',
      path: '/api/v2/assistant/capabilities',
      operationId: 'getAssistantCapabilities',
      requiredPermission: 'workspace.read',
    },
    {
      method: 'GET',
      path: '/api/v2/assistant/conversations',
      operationId: 'listAssistantConversations',
      requiredPermission: 'workspace.read',
    },
    {
      method: 'POST',
      path: '/api/v2/assistant/conversations',
      operationId: 'createAssistantConversation',
      requiredPermission: 'workspace.read',
    },
    {
      method: 'GET',
      path: '/api/v2/assistant/conversations/{id}',
      operationId: 'getAssistantConversation',
      requiredPermission: 'workspace.read',
    },
    {
      method: 'PATCH',
      path: '/api/v2/assistant/conversations/{id}',
      operationId: 'updateAssistantConversation',
      requiredPermission: 'workspace.read',
    },
    {
      method: 'DELETE',
      path: '/api/v2/assistant/conversations/{id}',
      operationId: 'deleteAssistantConversation',
      requiredPermission: 'workspace.read',
    },
    {
      method: 'GET',
      path: '/api/v2/assistant/conversations/{id}/messages',
      operationId: 'listAssistantMessages',
      requiredPermission: 'workspace.read',
    },
    {
      method: 'POST',
      path: '/api/v2/assistant/conversations/{id}/messages',
      operationId: 'postAssistantMessage',
      requiredPermission: 'workspace.read',
    },
    {
      method: 'PUT',
      path: '/api/v2/assistant/conversations/{id}/context',
      operationId: 'updateAssistantContext',
      requiredPermission: 'workspace.read',
    },
    {
      method: 'POST',
      path: '/api/v2/assistant/conversations/{id}/actions',
      operationId: 'prepareAssistantAction',
      requiredPermission: 'workspace.read',
    },
    {
      method: 'POST',
      path: '/api/v2/assistant/turns/{id}/cancel',
      operationId: 'cancelAssistantTurn',
      requiredPermission: 'workspace.read',
    },
    {
      method: 'POST',
      path: '/api/v2/assistant/turns/{id}/retry',
      operationId: 'retryAssistantTurn',
      requiredPermission: 'workspace.read',
    },
    {
      method: 'GET',
      path: '/api/v2/assistant/actions/{id}',
      operationId: 'getAssistantAction',
      requiredPermission: 'workspace.read',
    },
    {
      method: 'POST',
      path: '/api/v2/assistant/actions/{id}/execute',
      operationId: 'executeAssistantAction',
      requiredPermission: 'workspace.read',
    },
    {
      method: 'GET',
      path: '/api/v2/assistant/lessons',
      operationId: 'listAssistantLessons',
      requiredPermission: 'workspace.read',
    },
    {
      method: 'POST',
      path: '/api/v2/assistant/conversations/{id}/lesson-progress',
      operationId: 'updateAssistantLesson',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'clearRuleCache',
      method: 'POST',
      path: '/api/v2/rules/cache/clear',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'analyzeDraftTaskRule',
      method: 'POST',
      path: '/api/v2/rules/analyze',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'analyzeTaskRule',
      method: 'POST',
      path: '/api/v2/tasks/{taskId}/rule-analysis',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'explainRunFailure',
      method: 'POST',
      path: '/api/v2/runs/{runId}/explain-failure',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'extractTaskWithAi',
      method: 'POST',
      path: '/api/v2/tasks/{taskId}/ai/extract',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'extractDraftTaskWithAi',
      method: 'POST',
      path: '/api/v2/rules/ai-extract',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'createRuleRepairProposal',
      method: 'POST',
      path: '/api/v2/tasks/{taskId}/rules/{ruleId}/repair-proposals',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'testRuleRepairProposal',
      method: 'POST',
      path: '/api/v2/tasks/{taskId}/rules/{ruleId}/repair-proposals/{proposalId}/test',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'applyRuleRepairProposal',
      method: 'POST',
      path: '/api/v2/tasks/{taskId}/rules/{ruleId}/repair-proposals/{proposalId}/apply',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'rejectRuleRepairProposal',
      method: 'POST',
      path: '/api/v2/tasks/{taskId}/rules/{ruleId}/repair-proposals/{proposalId}/reject',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'listCrawlerAssistantConversations',
      method: 'GET',
      path: '/api/v2/crawler-assistant/conversations',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'createCrawlerAssistantConversation',
      method: 'POST',
      path: '/api/v2/crawler-assistant/conversations',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'getCrawlerAssistantConversation',
      method: 'GET',
      path: '/api/v2/crawler-assistant/conversations/{id}',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'deleteCrawlerAssistantConversation',
      method: 'DELETE',
      path: '/api/v2/crawler-assistant/conversations/{id}',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'listCrawlerAssistantMessages',
      method: 'GET',
      path: '/api/v2/crawler-assistant/conversations/{id}/messages',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'postCrawlerAssistantMessage',
      method: 'POST',
      path: '/api/v2/crawler-assistant/conversations/{id}/messages',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'selectCrawlerAssistantSite',
      method: 'POST',
      path: '/api/v2/crawler-assistant/conversations/{id}/site-selection',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'testCrawlerAssistantDraft',
      method: 'POST',
      path: '/api/v2/crawler-assistant/conversations/{id}/draft/test',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'commitCrawlerAssistantDraft',
      method: 'POST',
      path: '/api/v2/crawler-assistant/conversations/{id}/commit',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'cancelCrawlerAssistantTurn',
      method: 'POST',
      path: '/api/v2/crawler-assistant/turns/{id}/cancel',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'retryCrawlerAssistantTurn',
      method: 'POST',
      path: '/api/v2/crawler-assistant/turns/{id}/retry',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'getAiProviderSettings',
      method: 'GET',
      path: '/api/v2/ai/provider',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'updateAiProviderSettings',
      method: 'PUT',
      path: '/api/v2/ai/provider',
      requiredPermission: 'output.manage',
    },
    {
      operationId: 'promptAiProviderCredential',
      method: 'POST',
      path: '/api/v2/ai/provider/credential/prompt',
      requiredPermission: 'output.manage',
    },
    {
      operationId: 'deleteAiProviderCredential',
      method: 'DELETE',
      path: '/api/v2/ai/provider/credential',
      requiredPermission: 'output.manage',
    },
    {
      operationId: 'testAiProviderSettings',
      method: 'POST',
      path: '/api/v2/ai/provider/test',
      requiredPermission: 'output.manage',
    },
  ],
  events: [
    {
      type: 'ai.request.completed',
      durable: true,
    },
    {
      type: 'assistant.updated',
      durable: false,
    },
    {
      type: 'assistant.delta',
      durable: false,
    },
    {
      type: 'assistant.tool',
      durable: false,
    },
    {
      type: 'ai.turn.delta',
      durable: false,
    },
    {
      type: 'ai.turn.status',
      durable: false,
    },
    {
      type: 'ai.tool.status',
      durable: false,
    },
    {
      type: 'ai.draft.updated',
      durable: false,
    },
  ],
  migrations: [
    {
      id: '005-cost-accounting',
      tables: [],
    },
    {
      id: '003-validated-cache',
      tables: ['ai_validated_cache_state', 'ai_validated_cache'],
    },
    {
      id: '004-cache-owners',
      tables: [],
    },
    {
      id: '002-assistant',
      tables: ['ai_assistant_records'],
    },
    {
      id: '001-conversations',
      tables: [
        'ai_provider_settings',
        'ai_conversations',
        'ai_messages',
        'ai_turns',
        'ai_draft_versions',
        'ai_tool_invocations',
      ],
    },
  ],
  uiContributions: [
    {
      id: 'ai-assistance.crawler-assistant-route',
      kind: 'route',
    },
    {
      id: 'ai-assistance.crawler-assistant-navigation',
      kind: 'navigation',
    },
    {
      id: 'ai-assistance.rule-analysis-panel',
      kind: 'panel',
    },
    {
      id: 'ai-assistance.failure-explanation-panel',
      kind: 'panel',
    },
  ],
  backgroundHandlers: [
    {
      type: 'ai.conversation.turn',
      resourceClass: 'browser-heavy',
    },
    {
      type: 'ai.assistant.turn',
      resourceClass: 'io',
    },
    {
      type: 'ai.assistant.browser',
      resourceClass: 'browser-heavy',
    },
  ],
} as const satisfies PluginManifest;
export default aiAssistancePlugin;
