import type {} from '@zhiyun/ui-sdk';
import type { Context } from '@deepseek-ai/cordis';
import { Settings } from 'lucide-react';
import { lazy, type ComponentType } from 'react';
const SettingsPage = lazy(() => import('./pages/SettingsPage.js').then(moduleOf('SettingsPage')));

function moduleOf<T extends string>(name: T) {
  return (module: Record<T, ComponentType>) => ({ default: module[name] });
}
export const inject = ['slots', 'runtimeClient', 'queryClient', 'locale'];
export function apply(ctx: Context) {
  ctx.effect(
    () =>
      ctx.slots.registerRoute({
        order: 5,
        id: 'platform.settings-route',
        routes: [{ path: '/settings', component: SettingsPage }],
      }),
    'platform.settings-route',
  );
  ctx.effect(
    () =>
      ctx.slots.registerNavigation({
        order: 18,
        id: 'platform.settings-navigation',
        requiredPermission: 'output.manage',
        to: '/settings',
        labelKey: 'settings',
        group: 'system',
        icon: Settings,
      }),
    'platform.settings-navigation',
  );
}
export default { inject, apply };
