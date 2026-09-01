import type { UiContribution } from '@zhiyun/kernel';

export const aiAssistanceUiContributions = [
  { id: 'ai-assistance.crawler-assistant-route', kind: 'route' },
  { id: 'ai-assistance.crawler-assistant-navigation', kind: 'navigation' },
  { id: 'ai-assistance.rule-analysis-panel', kind: 'panel' },
  { id: 'ai-assistance.failure-explanation-panel', kind: 'panel' },
] as const satisfies readonly UiContribution[];
