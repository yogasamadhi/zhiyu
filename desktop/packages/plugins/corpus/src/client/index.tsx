import type {} from '@zhiyun/ui-sdk';
import type { Context } from '@deepseek-ai/cordis';
import { BookOpen } from 'lucide-react';
import { lazy, type ComponentType } from 'react';
const CorporaPage = lazy(() => import('./pages/CorporaPage.js').then(moduleOf('CorporaPage')));
const CorpusDetailPage = lazy(() =>
  import('./pages/CorpusDetailPage.js').then(moduleOf('CorpusDetailPage')),
);
const CorpusVersionPage = lazy(() =>
  import('./pages/CorpusVersionPage.js').then(moduleOf('CorpusVersionPage')),
);

function moduleOf<T extends string>(name: T) {
  return (module: Record<T, ComponentType>) => ({ default: module[name] });
}
export const inject = ['slots', 'runtimeClient', 'queryClient', 'locale'];
export function apply(ctx: Context) {
  ctx.effect(
    () =>
      ctx.slots.registerRoute({
        order: 7,
        id: 'corpus.route',
        routes: [
          { path: '/corpora', component: CorporaPage },
          { path: '/corpora/:corpusId', component: CorpusDetailPage },
          { path: '/corpora/:corpusId/versions/:versionId', component: CorpusVersionPage },
        ],
      }),
    'corpus.route',
  );
  ctx.effect(
    () =>
      ctx.slots.registerNavigation({
        order: 17,
        id: 'corpus.navigation',
        to: '/corpora',
        labelKey: 'corpus.title',
        group: 'data',
        icon: BookOpen,
      }),
    'corpus.navigation',
  );
}
export default { inject, apply };
