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
  events: [{ type: 'ai.request.completed', durable: true }],
  uiContributions: aiAssistanceUiContributions,
  activate() {},
};

export * from './application/index.js';
export * from './contracts/index.js';
export * from './domain/index.js';
export * from './http/index.js';
export * from './ui/index.js';
