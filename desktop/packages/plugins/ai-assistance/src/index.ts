import { createServiceToken, type PluginDescriptor } from '@zhiyun/kernel';
import type { AiAssistanceServiceContract } from './contracts/index.js';
import { aiAssistanceRoutes } from './http/index.js';
import { aiAssistanceUiContributions } from './ui/index.js';

export const aiAssistanceService = createServiceToken<AiAssistanceServiceContract>(
  'ai-assistance.service',
  '1.0.0',
  'ai-assistance',
);

export const aiAssistancePlugin: PluginDescriptor = {
  id: 'ai-assistance',
  version: '1.0.0',
  dependencies: [{ id: 'collection', range: '^1.0.0' }],
  optionalCapabilities: ['ai.provider'],
  providedServices: [aiAssistanceService],
  routes: aiAssistanceRoutes,
  events: [
    { type: 'ai.request.completed', durable: true },
    { type: 'assistant.updated', durable: false },
    { type: 'assistant.delta', durable: false },
    { type: 'assistant.tool', durable: false },
    { type: 'ai.turn.delta', durable: false },
    { type: 'ai.turn.status', durable: false },
    { type: 'ai.tool.status', durable: false },
    { type: 'ai.draft.updated', durable: false },
  ],
  migrations: [
    { id: '005-cost-accounting', tables: [] },
    { id: '003-validated-cache', tables: ['ai_validated_cache_state', 'ai_validated_cache'] },
    { id: '004-cache-owners', tables: [] },
    { id: '002-assistant', tables: ['ai_assistant_records'] },
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
  uiContributions: aiAssistanceUiContributions,
  backgroundHandlers: [
    { type: 'ai.conversation.turn', resourceClass: 'browser-heavy' },
    { type: 'ai.assistant.turn', resourceClass: 'io' },
    { type: 'ai.assistant.browser', resourceClass: 'browser-heavy' },
  ],
  activate() {},
};

export * from './application/index.js';
export * from './application/rule-cache.js';
export * from './contracts/index.js';
export * from './domain/index.js';
export * from './http/index.js';
export * from './persistence/sqlite/index.js';
export * from './ui/index.js';
