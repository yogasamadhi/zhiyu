import { describe, expect, it } from 'vitest';
import { resolveUiContributions } from '../src/shell/contributions.js';

describe('UI Contribution Registry', () => {
  it('intersects Runtime IDs with the signed build-time registry', () => {
    const resolved = resolveUiContributions([
      'collection.route',
      'collection.navigation',
      'unknown.remote-code',
    ]);
    expect(resolved.routes.map(({ id }) => id)).toEqual(['collection.route']);
    expect(resolved.navigation.map(({ id }) => id)).toEqual(['collection.navigation']);
  });

  it('loads Analytics and Corpus routes only for their signed contribution IDs', () => {
    const resolved = resolveUiContributions([
      'analytics.route',
      'analytics.navigation',
      'corpus.route',
      'corpus.navigation',
    ]);
    expect(resolved.routes.map(({ id }) => id)).toEqual(['analytics.route', 'corpus.route']);
    expect(resolved.routes.flatMap(({ routes }) => routes.map(({ path }) => path))).toEqual(
      expect.arrayContaining([
        '/analytics',
        '/analytics/recipes/:recipeId',
        '/analytics/jobs/:jobId',
        '/corpora',
        '/corpora/:corpusId',
        '/corpora/:corpusId/versions/:versionId',
      ]),
    );
    expect(resolved.navigation.map(({ id }) => id)).toEqual([
      'analytics.navigation',
      'corpus.navigation',
    ]);
  });
});
