import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

const TaskListPage = lazy(() => import('../pages/TaskListPage.js').then(moduleOf('TaskListPage')));
const TaskEditorPage = lazy(() =>
  import('../pages/TaskEditorPage.js').then(moduleOf('TaskEditorPage')),
);
const TaskDetailPage = lazy(() =>
  import('../pages/TaskDetailPage.js').then(moduleOf('TaskDetailPage')),
);
const RunDetailPage = lazy(() =>
  import('../pages/RunDetailPage.js').then(moduleOf('RunDetailPage')),
);
const DatasetPage = lazy(() => import('../pages/DatasetPage.js').then(moduleOf('DatasetPage')));
const OutputsPage = lazy(() => import('../pages/OutputsPage.js').then(moduleOf('OutputsPage')));
const SettingsPage = lazy(() => import('../pages/SettingsPage.js').then(moduleOf('SettingsPage')));
const PreferencesPage = lazy(() =>
  import('../pages/PreferencesPage.js').then(moduleOf('PreferencesPage')),
);

export interface ShellRouteContribution {
  id: string;
  routes: Array<{ path: string; component: LazyExoticComponent<ComponentType> }>;
}

export interface ShellNavigationContribution {
  id: string;
  to: string;
  labelKey: string;
}

export const routeContributionRegistry: readonly ShellRouteContribution[] = [
  {
    id: 'collection.route',
    routes: [
      { path: '/', component: TaskListPage },
      { path: '/tasks/new', component: TaskEditorPage },
      { path: '/tasks/:id/edit', component: TaskEditorPage },
      { path: '/tasks/:id', component: TaskDetailPage },
      { path: '/runs/:id', component: RunDetailPage },
    ],
  },
  {
    id: 'datasets.route',
    routes: [{ path: '/tasks/:id/dataset', component: DatasetPage }],
  },
  {
    id: 'preferences.route',
    routes: [{ path: '/preferences', component: PreferencesPage }],
  },
  {
    id: 'outputs.route',
    routes: [{ path: '/outputs', component: OutputsPage }],
  },
  {
    id: 'platform.settings-route',
    routes: [{ path: '/settings', component: SettingsPage }],
  },
];

export const navigationContributionRegistry: readonly ShellNavigationContribution[] = [
  { id: 'collection.navigation', to: '/', labelKey: 'tasks' },
  {
    id: 'preferences.navigation',
    to: '/preferences',
    labelKey: 'preferencesAndTrends',
  },
  { id: 'outputs.navigation', to: '/outputs', labelKey: 'outputs' },
  { id: 'platform.settings-navigation', to: '/settings', labelKey: 'settings' },
];

export function resolveUiContributions(enabledIds: readonly string[]) {
  const enabled = new Set(enabledIds);
  return {
    routes: routeContributionRegistry.filter(({ id }) => enabled.has(id)),
    navigation: navigationContributionRegistry.filter(({ id }) => enabled.has(id)),
  };
}

function moduleOf<T extends string>(name: T) {
  return (module: Record<T, ComponentType>) => ({ default: module[name] });
}
