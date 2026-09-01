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
    expect(resolved.routes[0]?.routes.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        '/',
        '/tasks',
        '/tasks/new',
        '/tasks/:id/edit',
        '/tasks/:id/quality',
        '/tasks/:id/analysis',
        '/tasks/:id/output',
        '/tasks/:id/runs',
      ]),
    );
    expect(resolved.routes[0]?.routes.map(({ path }) => path)).not.toContain('/tasks/:id/:section');
    expect(resolved.navigation[0]).toMatchObject({
      to: '/tasks',
      group: 'collection',
    });
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

  it('registers the recruitment radar inside the Collection navigation group', () => {
    const resolved = resolveUiContributions(['recruitment.route', 'recruitment.navigation']);
    expect(resolved.routes[0]?.routes.map(({ path }) => path)).toEqual([
      '/recruitment',
      '/recruitment/job-clusters/:clusterId',
    ]);
    expect(resolved.navigation).toEqual([
      expect.objectContaining({
        id: 'recruitment.navigation',
        to: '/recruitment',
        group: 'collection',
      }),
    ]);
  });

  it('registers the stable identity member and audit contribution IDs', () => {
    const resolved = resolveUiContributions([
      'identity.members-route',
      'identity.members-navigation',
      'identity.audit-route',
      'identity.audit-navigation',
    ]);
    expect(resolved.routes.map(({ id }) => id)).toEqual([
      'identity.members-route',
      'identity.audit-route',
    ]);
    expect(resolved.routes.flatMap(({ routes }) => routes.map(({ path }) => path))).toEqual([
      '/members',
      '/audit',
    ]);
    expect(resolved.navigation.map(({ id }) => id)).toEqual([
      'identity.members-navigation',
      'identity.audit-navigation',
    ]);
  });
});
