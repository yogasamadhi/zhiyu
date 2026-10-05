import {
  ListTodo,
  Database,
  ChartColumn,
  Workflow,
  LayoutGrid,
  Settings,
  Users,
  History,
  Briefcase,
  TrendingUp,
  BookOpen,
  type LucideIcon,
} from 'lucide-react';
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { taskDetailSectionRoutePaths } from '../task-detail.js';

const DatasetsPage = lazy(() => import('../pages/DatasetsPage.js').then(moduleOf('DatasetsPage')));
const ScenariosPage = lazy(() =>
  import('../pages/ScenariosPage.js').then(moduleOf('ScenariosPage')),
);
const TaskListPage = lazy(() => import('../pages/TaskListPage.js').then(moduleOf('TaskListPage')));
const HomeDashboardPage = lazy(() =>
  import('../pages/HomeDashboardPage.js').then(moduleOf('HomeDashboardPage')),
);
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
const RecruitmentPage = lazy(() =>
  import('../pages/RecruitmentPage.js').then(moduleOf('RecruitmentPage')),
);
const RecruitmentClusterPage = lazy(() =>
  import('../pages/RecruitmentClusterPage.js').then(moduleOf('RecruitmentClusterPage')),
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
const AssistantPage = lazy(() =>
  import('../pages/AssistantPage.js').then(moduleOf('AssistantPage')),
);
const LegacyCrawlerAssistantRedirect = lazy(() =>
  import('../pages/LegacyCrawlerAssistantRedirect.js').then(
    moduleOf('LegacyCrawlerAssistantRedirect'),
  ),
);
const MembersPage = lazy(() => import('../pages/MembersPage.js').then(moduleOf('MembersPage')));
const AuditPage = lazy(() => import('../pages/AuditPage.js').then(moduleOf('AuditPage')));

export type ShellNavigationGroup = 'collection' | 'data' | 'automation' | 'system';

export interface ShellRouteContribution {
  id: string;
  routes: Array<{ path: string; component: LazyExoticComponent<ComponentType> }>;
}

export interface ShellNavigationContribution {
  id: string;
  to: string;
  labelKey: string;
  group: ShellNavigationGroup;
  icon: LucideIcon;
}

export const routeContributionRegistry: readonly ShellRouteContribution[] = [
  {
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
  },
  {
    id: 'datasets.route',
    routes: [
      { path: '/datasets', component: DatasetsPage },
      { path: '/datasets/:datasetId', component: DatasetPage },
      { path: '/tasks/:taskId/dataset', component: DatasetPage },
    ],
  },
  {
    id: 'preferences.route',
    routes: [{ path: '/preferences', component: PreferencesPage }],
  },
  {
    id: 'recruitment.route',
    routes: [
      { path: '/recruitment', component: RecruitmentPage },
      { path: '/recruitment/job-clusters/:clusterId', component: RecruitmentClusterPage },
    ],
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
      { path: '/analytics/results/:resultId', component: AnalysisJobPage },
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
  {
    id: 'ai-assistance.crawler-assistant-route',
    routes: [
      { path: '/crawler-assistant', component: LegacyCrawlerAssistantRedirect },
      { path: '/assistant', component: AssistantPage },
    ],
  },
  {
    id: 'identity.members-route',
    routes: [{ path: '/members', component: MembersPage }],
  },
  {
    id: 'identity.audit-route',
    routes: [{ path: '/audit', component: AuditPage }],
  },
];

export const navigationContributionRegistry: readonly ShellNavigationContribution[] = [
  {
    id: 'datasets.navigation',
    to: '/datasets',
    labelKey: 'ux.datasets',
    group: 'data',
    icon: Database,
  },
  {
    id: 'collection.scenarios-navigation',
    to: '/scenarios',
    labelKey: 'ux.scenarios',
    group: 'automation',
    icon: LayoutGrid,
  },
  {
    id: 'collection.navigation',
    to: '/tasks',
    labelKey: 'tasks',
    group: 'collection',
    icon: ListTodo,
  },
  {
    id: 'preferences.navigation',
    to: '/preferences',
    labelKey: 'preferencesAndTrends',
    group: 'collection',
    icon: TrendingUp,
  },
  {
    id: 'recruitment.navigation',
    to: '/recruitment',
    labelKey: 'recruitment',
    group: 'collection',
    icon: Briefcase,
  },
  {
    id: 'outputs.navigation',
    to: '/outputs',
    labelKey: 'ux.automation',
    group: 'automation',
    icon: Workflow,
  },
  {
    id: 'analytics.navigation',
    to: '/analytics',
    labelKey: 'ux.analysis',
    group: 'data',
    icon: ChartColumn,
  },
  {
    id: 'corpus.navigation',
    to: '/corpora',
    labelKey: 'corpus.title',
    group: 'data',
    icon: BookOpen,
  },
  {
    id: 'platform.settings-navigation',
    to: '/settings',
    labelKey: 'settings',
    group: 'system',
    icon: Settings,
  },
  {
    id: 'identity.members-navigation',
    to: '/members',
    labelKey: 'members',
    group: 'system',
    icon: Users,
  },
  {
    id: 'identity.audit-navigation',
    to: '/audit',
    labelKey: 'audit',
    group: 'system',
    icon: History,
  },
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
