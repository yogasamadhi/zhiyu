import type {} from '@zhiyun/ui-sdk';
import type { Context } from '@deepseek-ai/cordis';
import { AssistantProvider } from '@zhiyun/ui-sdk/components/assistant/AssistantProvider';
import { AssistantHost } from '@zhiyun/ui-sdk/components/assistant/AssistantWorkspace';
import { lazy, type ComponentType } from 'react';
const LegacyCrawlerAssistantRedirect = lazy(() =>
  import('./pages/LegacyCrawlerAssistantRedirect.js').then(
    moduleOf('LegacyCrawlerAssistantRedirect'),
  ),
);
const AssistantPage = lazy(() =>
  import('./pages/AssistantPage.js').then(moduleOf('AssistantPage')),
);

function moduleOf<T extends string>(name: T) {
  return (module: Record<T, ComponentType>) => ({ default: module[name] });
}
export const inject = ['slots', 'runtimeClient', 'queryClient', 'locale'];
export function apply(ctx: Context) {
  ctx.effect(() =>
    ctx.slots.registerWrapper({
      id: 'ai-assistance.rule-analysis-panel',
      order: 0,
      component: AssistantProvider,
    }),
  );
  ctx.effect(() =>
    ctx.slots.registerPanel({
      id: 'ai-assistance.failure-explanation-panel',
      order: 0,
      component: AssistantHost,
    }),
  );
  ctx.effect(
    () =>
      ctx.slots.registerRoute({
        order: 8,
        id: 'ai-assistance.crawler-assistant-route',
        routes: [
          { path: '/crawler-assistant', component: LegacyCrawlerAssistantRedirect },
          { path: '/assistant', component: AssistantPage },
        ],
      }),
    'ai-assistance.crawler-assistant-route',
  );
}
export default { inject, apply };
