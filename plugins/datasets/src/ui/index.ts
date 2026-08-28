import type { UiContribution } from '@zhiyun/kernel';

export const datasetsUiContributions = [
  { id: 'datasets.route', kind: 'route' },
  { id: 'datasets.task-panel', kind: 'panel' },
] as const satisfies readonly UiContribution[];
