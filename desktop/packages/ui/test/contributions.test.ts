import { describe, expect, it, vi } from 'vitest';
import { createClientRuntime } from '../src/shell/client-runtime.js';
import profiles from '../src/generated/client-profiles.json';
import { Context } from '@deepseek-ai/cordis';
import { UiSlots } from '@zhiyun/ui-sdk';
import { QueryClient } from '@tanstack/react-query';
async function resolveUiContributions(enabledIds: readonly string[]) {
  const ctx = await createClientRuntime(
    {
      profileId: 'identity-test',
      graphRevision: 'test',
      plugins: profiles['identity-test'].map(({ id }) => ({
        id,
        version: '1.0.0',
        dependencies: [],
      })),
      routes: [],
      uiContributions: enabledIds.map((id) => ({
        id,
        kind: id.endsWith('route') ? ('route' as const) : ('navigation' as const),
        ownerPluginId: id.split('.')[0]!,
      })),
    },
    new QueryClient(),
  );
  try {
    return ctx.slots.getSnapshot();
  } finally {
    await ctx.fiber.dispose();
  }
}

describe('UI Contribution Registry', async () => {
  it('intersects Runtime IDs with the signed build-time registry', async () => {
    const resolved = await resolveUiContributions([
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

  it('loads Analytics and Corpus routes only for their signed contribution IDs', async () => {
    const resolved = await resolveUiContributions([
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

  it('registers the recruitment radar inside the Collection navigation group', async () => {
    const resolved = await resolveUiContributions(['recruitment.route', 'recruitment.navigation']);
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

  it('registers the stable identity member and audit contribution IDs', async () => {
    const resolved = await resolveUiContributions([
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
  it('releases registrations and subscribers before a new client tree starts', async () => {
    const ctx = new Context();
    await ctx.plugin(UiSlots, new Set(['fixture.navigation'])).await();
    const listener = vi.fn();
    const slots = ctx.slots;
    ctx.effect(() => slots.subscribe(listener));
    const entry = {
      id: 'fixture.navigation',
      order: 1,
      to: '/fixture',
      labelKey: 'fixture',
      group: 'data' as const,
      icon: (() => null) as never,
    };
    const unregister = slots.registerNavigation(entry);
    expect(() => slots.registerNavigation(entry)).toThrow(/Duplicate UI contribution/);
    unregister();
    expect(slots.getSnapshot().navigation).toEqual([]);
    slots.registerNavigation(entry);
    await ctx.fiber.dispose();
    expect(slots.getSnapshot().navigation).toEqual([]);
    const calls = listener.mock.calls.length;
    slots.subscribe(() => {});
    expect(listener.mock.calls.length).toBe(calls);
  });

  it('reports an unsupported runtime profile with its identifier', async () => {
    await expect(
      createClientRuntime(
        {
          profileId: 'unknown',
          graphRevision: 'test',
          plugins: [],
          routes: [],
          uiContributions: [],
        },
        new QueryClient(),
      ),
    ).rejects.toThrow('unknown');
  });
});
