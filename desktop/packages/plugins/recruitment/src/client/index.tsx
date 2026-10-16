import type {} from '@zhiyun/ui-sdk';
import type { Context } from '@deepseek-ai/cordis';
import { Briefcase } from 'lucide-react';
import { lazy, type ComponentType } from 'react';
const RecruitmentPage = lazy(() =>
  import('./pages/RecruitmentPage.js').then(moduleOf('RecruitmentPage')),
);
const RecruitmentClusterPage = lazy(() =>
  import('./pages/RecruitmentClusterPage.js').then(moduleOf('RecruitmentClusterPage')),
);

function moduleOf<T extends string>(name: T) {
  return (module: Record<T, ComponentType>) => ({ default: module[name] });
}
export const inject = ['slots', 'runtimeClient', 'queryClient', 'locale'];
export function apply(ctx: Context) {
  ctx.effect(
    () =>
      ctx.slots.registerRoute({
        order: 3,
        id: 'recruitment.route',
        routes: [
          { path: '/recruitment', component: RecruitmentPage },
          { path: '/recruitment/job-clusters/:clusterId', component: RecruitmentClusterPage },
        ],
      }),
    'recruitment.route',
  );
  ctx.effect(
    () =>
      ctx.slots.registerNavigation({
        order: 14,
        id: 'recruitment.navigation',
        to: '/recruitment',
        labelKey: 'recruitment',
        group: 'collection',
        icon: Briefcase,
      }),
    'recruitment.navigation',
  );
}
export default { inject, apply };
