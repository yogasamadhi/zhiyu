import type {} from '@zhiyun/ui-sdk';
import type { Context } from '@deepseek-ai/cordis';
import { Database } from 'lucide-react';
import { lazy, type ComponentType } from 'react';
const DatasetsPage = lazy(() => import('./pages/DatasetsPage.js').then(moduleOf('DatasetsPage')));
const DatasetPage = lazy(() => import('./pages/DatasetPage.js').then(moduleOf('DatasetPage')));

function moduleOf<T extends string>(name: T) {
  return (module: Record<T, ComponentType>) => ({ default: module[name] });
}
export const inject = ['slots', 'runtimeClient', 'queryClient', 'locale'];
export function apply(ctx: Context) {
  ctx.effect(
    () =>
      ctx.slots.registerRoute({
        order: 1,
        id: 'datasets.route',
        routes: [
          { path: '/datasets', component: DatasetsPage },
          { path: '/datasets/:datasetId', component: DatasetPage },
          { path: '/tasks/:taskId/dataset', component: DatasetPage },
        ],
      }),
    'datasets.route',
  );
  ctx.effect(
    () =>
      ctx.slots.registerNavigation({
        order: 1,
        id: 'datasets.navigation',
        to: '/datasets',
        labelKey: 'ux.datasets',
        group: 'data',
        icon: Database,
      }),
    'datasets.navigation',
  );
}
export default { inject, apply };
