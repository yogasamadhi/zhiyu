import type {} from '@zhiyun/ui-sdk';
import type { Context } from '@deepseek-ai/cordis';
import { Workflow } from 'lucide-react';
import { lazy, type ComponentType } from 'react';
const OutputsPage = lazy(() => import('./pages/OutputsPage.js').then(moduleOf('OutputsPage')));

function moduleOf<T extends string>(name: T) {
  return (module: Record<T, ComponentType>) => ({ default: module[name] });
}
export const inject = ['slots', 'runtimeClient', 'queryClient', 'locale'];
export function apply(ctx: Context) {
  ctx.effect(
    () =>
      ctx.slots.registerRoute({
        order: 4,
        id: 'outputs.route',
        routes: [{ path: '/outputs', component: OutputsPage }],
      }),
    'outputs.route',
  );
  ctx.effect(
    () =>
      ctx.slots.registerNavigation({
        order: 3,
        id: 'outputs.navigation',
        requiredPermission: 'output.manage',
        to: '/outputs',
        labelKey: 'ux.automation',
        group: 'automation',
        icon: Workflow,
      }),
    'outputs.navigation',
  );
}
export default { inject, apply };
