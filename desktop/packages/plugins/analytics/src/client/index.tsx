import type {} from '@zhiyun/ui-sdk';
import type { Context } from '@deepseek-ai/cordis';
import { ChartColumn } from 'lucide-react';
import { lazy, type ComponentType } from 'react';
const AnalyticsPage = lazy(() =>
  import('./pages/AnalyticsPage.js').then(moduleOf('AnalyticsPage')),
);
const AnalyticsRecipePage = lazy(() =>
  import('./pages/AnalyticsRecipePage.js').then(moduleOf('AnalyticsRecipePage')),
);
const AnalysisJobPage = lazy(() =>
  import('./pages/AnalysisJobPage.js').then(moduleOf('AnalysisJobPage')),
);

function moduleOf<T extends string>(name: T) {
  return (module: Record<T, ComponentType>) => ({ default: module[name] });
}
export const inject = ['slots', 'runtimeClient', 'queryClient', 'locale'];
export function apply(ctx: Context) {
  ctx.effect(
    () =>
      ctx.slots.registerRoute({
        order: 6,
        id: 'analytics.route',
        routes: [
          { path: '/analytics', component: AnalyticsPage },
          { path: '/analytics/recipes/:recipeId', component: AnalyticsRecipePage },
          { path: '/analytics/jobs/:jobId', component: AnalysisJobPage },
          { path: '/analytics/results/:resultId', component: AnalysisJobPage },
        ],
      }),
    'analytics.route',
  );
  ctx.effect(
    () =>
      ctx.slots.registerNavigation({
        order: 2,
        id: 'analytics.navigation',
        to: '/analytics',
        labelKey: 'ux.analysis',
        group: 'data',
        icon: ChartColumn,
      }),
    'analytics.navigation',
  );
}
export default { inject, apply };
