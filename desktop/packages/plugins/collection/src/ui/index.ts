import type { UiContribution } from '@zhiyun/kernel';

export const collectionUiContributions = [
  { id: 'collection.scenarios-navigation', kind: 'navigation' },
  { id: 'collection.route', kind: 'route' },
  { id: 'collection.navigation', kind: 'navigation' },
  { id: 'collection.run-panel', kind: 'panel' },
] as const satisfies readonly UiContribution[];
