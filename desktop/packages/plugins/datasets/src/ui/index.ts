import type { UiContribution } from '@zhiyun/kernel';

export const datasetsUiContributions = [
  { id: 'datasets.navigation', kind: 'navigation' },
  { id: 'datasets.route', kind: 'route' },
  { id: 'datasets.task-panel', kind: 'panel' },
] as const satisfies readonly UiContribution[];
