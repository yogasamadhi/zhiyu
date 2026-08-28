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
const AnalyticsPage = lazy(() =>
  import('../pages/AnalyticsPage.js').then(moduleOf('AnalyticsPage')),
);
const AnalyticsRecipePage = lazy(() =>
  import('../pages/AnalyticsRecipePage.js').then(moduleOf('AnalyticsRecipePage')),
);
const AnalysisJobPage = lazy(() =>
  import('../pages/AnalysisJobPage.js').then(moduleOf('AnalysisJobPage')),
);
const CorporaPage = lazy(() => import('../pages/CorporaPage.js').then(moduleOf('CorporaPage')));
const CorpusDetailPage = lazy(() =>
  import('../pages/CorpusDetailPage.js').then(moduleOf('CorpusDetailPage')),
);
const CorpusVersionPage = lazy(() =>
  import('../pages/CorpusVersionPage.js').then(moduleOf('CorpusVersionPage')),
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
  {
    id: 'analytics.route',
    routes: [
      { path: '/analytics', component: AnalyticsPage },
      { path: '/analytics/recipes/:recipeId', component: AnalyticsRecipePage },
      { path: '/analytics/jobs/:jobId', component: AnalysisJobPage },
    ],
  },
  {
    id: 'corpus.route',
    routes: [
      { path: '/corpora', component: CorporaPage },
      { path: '/corpora/:corpusId', component: CorpusDetailPage },
      { path: '/corpora/:corpusId/versions/:versionId', component: CorpusVersionPage },
    ],
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
  { id: 'analytics.navigation', to: '/analytics', labelKey: 'analytics.title' },
  { id: 'corpus.navigation', to: '/corpora', labelKey: 'corpus.title' },
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
