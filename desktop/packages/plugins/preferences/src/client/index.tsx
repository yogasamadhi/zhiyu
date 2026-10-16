import type {} from '@zhiyun/ui-sdk';
import type { Context } from '@deepseek-ai/cordis';
import { TrendingUp } from 'lucide-react';
import { lazy, type ComponentType } from 'react';
const PreferencesPage = lazy(() =>
  import('./pages/PreferencesPage.js').then(moduleOf('PreferencesPage')),
);

function moduleOf<T extends string>(name: T) {
  return (module: Record<T, ComponentType>) => ({ default: module[name] });
}
export const inject = ['slots', 'runtimeClient', 'queryClient', 'locale'];
export function apply(ctx: Context) {
  ctx.effect(
    () =>
      ctx.slots.registerRoute({
        order: 2,
        id: 'preferences.route',
        routes: [{ path: '/preferences', component: PreferencesPage }],
      }),
    'preferences.route',
  );
  ctx.effect(
    () =>
      ctx.slots.registerNavigation({
        order: 13,
        id: 'preferences.navigation',
        to: '/preferences',
        labelKey: 'preferencesAndTrends',
        group: 'collection',
        icon: TrendingUp,
      }),
    'preferences.navigation',
  );
}
export default { inject, apply };
