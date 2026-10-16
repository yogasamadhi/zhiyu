import type { UiContribution } from '@zhiyun/plugin-runtime';

export const preferencesUiContributions = [
  { id: 'preferences.route', kind: 'route' },
  { id: 'preferences.navigation', kind: 'navigation' },
] as const satisfies readonly UiContribution[];
