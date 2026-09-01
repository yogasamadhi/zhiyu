import type { UiContribution } from '@zhiyun/kernel';

export const recruitmentUiContributions = [
  { id: 'recruitment.route', kind: 'route' },
  { id: 'recruitment.navigation', kind: 'navigation' },
] as const satisfies readonly UiContribution[];
