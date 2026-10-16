import type {} from '@zhiyun/ui-sdk';
import type { Context } from '@deepseek-ai/cordis';
import { History, Users } from 'lucide-react';
import { lazy, type ComponentType } from 'react';
const MembersPage = lazy(() => import('./pages/MembersPage.js').then(moduleOf('MembersPage')));
const AuditPage = lazy(() => import('./pages/AuditPage.js').then(moduleOf('AuditPage')));

function moduleOf<T extends string>(name: T) {
  return (module: Record<T, ComponentType>) => ({ default: module[name] });
}
export const inject = ['slots', 'runtimeClient', 'queryClient', 'locale'];
export function apply(ctx: Context) {
  ctx.effect(
    () =>
      ctx.slots.registerRoute({
        order: 9,
        id: 'identity.members-route',
        routes: [{ path: '/members', component: MembersPage }],
      }),
    'identity.members-route',
  );
  ctx.effect(
    () =>
      ctx.slots.registerRoute({
        order: 10,
        id: 'identity.audit-route',
        routes: [{ path: '/audit', component: AuditPage }],
      }),
    'identity.audit-route',
  );
  ctx.effect(
    () =>
      ctx.slots.registerNavigation({
        order: 19,
        id: 'identity.members-navigation',
        requiredPermission: 'member.manage',
        to: '/members',
        labelKey: 'members',
        group: 'system',
        icon: Users,
      }),
    'identity.members-navigation',
  );
  ctx.effect(
    () =>
      ctx.slots.registerNavigation({
        order: 20,
        id: 'identity.audit-navigation',
        requiredPermission: 'audit.read',
        to: '/audit',
        labelKey: 'audit',
        group: 'system',
        icon: History,
      }),
    'identity.audit-navigation',
  );
}
export default { inject, apply };
