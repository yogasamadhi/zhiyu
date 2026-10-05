import type { UiContribution } from '@zhiyun/kernel';

export const outputsUiContributions = [
  { id: 'outputs.route', kind: 'route' },
  { id: 'outputs.navigation', kind: 'navigation' },
] as const satisfies readonly UiContribution[];
