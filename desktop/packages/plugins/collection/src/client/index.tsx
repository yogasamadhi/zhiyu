import type {} from '@zhiyun/ui-sdk';
import type { Context } from '@deepseek-ai/cordis';
import { taskDetailSectionRoutePaths } from '@zhiyun/ui-sdk/task-detail';
import { LayoutGrid, ListTodo } from 'lucide-react';
import { lazy, type ComponentType } from 'react';
const HomeDashboardPage = lazy(() =>
  import('./pages/HomeDashboardPage.js').then(moduleOf('HomeDashboardPage')),
);
const ScenariosPage = lazy(() =>
  import('./pages/ScenariosPage.js').then(moduleOf('ScenariosPage')),
);
const TaskListPage = lazy(() => import('./pages/TaskListPage.js').then(moduleOf('TaskListPage')));
const TaskEditorPage = lazy(() =>
  import('./pages/TaskEditorPage.js').then(moduleOf('TaskEditorPage')),
);
const TaskDetailPage = lazy(() =>
  import('./pages/TaskDetailPage.js').then(moduleOf('TaskDetailPage')),
);
const RunDetailPage = lazy(() =>
  import('./pages/RunDetailPage.js').then(moduleOf('RunDetailPage')),
);

function moduleOf<T extends string>(name: T) {
  return (module: Record<T, ComponentType>) => ({ default: module[name] });
}
export const inject = ['slots', 'runtimeClient', 'queryClient', 'locale'];
export function apply(ctx: Context) {
  ctx.effect(
    () =>
      ctx.slots.registerRoute({
        order: 0,
        id: 'collection.route',
        routes: [
          { path: '/', component: HomeDashboardPage },
          { path: '/scenarios', component: ScenariosPage },
          { path: '/tasks', component: TaskListPage },
          { path: '/tasks/new', component: TaskEditorPage },
          { path: '/tasks/:id/edit', component: TaskEditorPage },
          { path: '/tasks/:id', component: TaskDetailPage },
          ...taskDetailSectionRoutePaths.map((path) => ({ path, component: TaskDetailPage })),
          { path: '/runs/:id', component: RunDetailPage },
        ],
      }),
    'collection.route',
  );
  ctx.effect(
    () =>
      ctx.slots.registerNavigation({
        order: 4,
        id: 'collection.scenarios-navigation',
        to: '/scenarios',
        labelKey: 'ux.scenarios',
        group: 'automation',
        icon: LayoutGrid,
      }),
    'collection.scenarios-navigation',
  );
  ctx.effect(
    () =>
      ctx.slots.registerNavigation({
        order: 0,
        id: 'collection.navigation',
        to: '/tasks',
        labelKey: 'tasks',
        group: 'collection',
        icon: ListTodo,
      }),
    'collection.navigation',
  );
}
export default { inject, apply };
