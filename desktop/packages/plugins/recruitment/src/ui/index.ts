import type { UiContribution } from '@zhiyun/plugin-runtime';

export const recruitmentUiContributions = [
  { id: 'recruitment.route', kind: 'route' },
  { id: 'recruitment.navigation', kind: 'navigation' },
] as const satisfies readonly UiContribution[];
