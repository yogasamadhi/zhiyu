import { describe, expect, it } from 'vitest';
import { resolveGraph, type PluginManifest } from '../src/catalog.js';

const profile = { id: 'fixture', version: '1.0.0', bundleIds: ['fixture'] };
function graph(plugins: PluginManifest[], entries: readonly unknown[] = []) {
  return resolveGraph({
    profile,
    bundles: [{ id: 'fixture', version: '1.0.0', pluginIds: plugins.map(({ id }) => id) }],
    plugins,
    entries,
  });
}

describe('packaged plugin catalog invariants', () => {
  it('keeps revisions stable across registry order and hashes effective configuration', () => {
    const provider = { id: 'provider', version: '1.0.0' };
    const consumer = {
      id: 'consumer',
      version: '1.0.0',
      dependencies: [{ id: 'provider', range: '^1.0.0' }],
    };
    const resolve = (plugins: PluginManifest[], config: number) =>
      resolveGraph({
        profile,
        bundles: [{ id: 'fixture', version: '1.0.0', pluginIds: ['provider', 'consumer'] }],
        plugins,
        entries: [{ id: 'consumer', config: { value: config } }],
      });
    expect(resolve([consumer, provider], 1).revision).toBe(
      resolve([provider, consumer], 1).revision,
    );
    expect(resolve([provider, consumer], 1).revision).not.toBe(
      resolve([provider, consumer], 2).revision,
    );
  });
  it('rejects missing configured dependencies, cycles and incompatible versions', () => {
    expect(() =>
      graph([{ id: 'consumer', version: '1.0.0', dependencies: [{ id: 'missing' }] }]),
    ).toThrow(/missing plugin/);
    expect(() =>
      graph([
        { id: 'left', version: '1.0.0', dependencies: [{ id: 'right' }] },
        { id: 'right', version: '1.0.0', dependencies: [{ id: 'left' }] },
      ]),
    ).toThrow(/cycle/);
    expect(() =>
      graph([
        { id: 'provider', version: '2.0.0' },
        { id: 'consumer', version: '1.0.0', dependencies: [{ id: 'provider', range: '^1.0.0' }] },
      ]),
    ).toThrow(/requires provider/);
  });
  it('rejects duplicate service, route and UI contribution ownership', () => {
    for (const contribution of [
      { providedServices: [{ id: 'shared', version: '1.0.0' }] },
      {
        routes: [
          { operationId: 'shared', method: 'GET', path: '/shared', requiredPermission: null },
        ],
      },
      { uiContributions: [{ id: 'shared', kind: 'route' as const }] },
    ])
      expect(() =>
        graph([
          { id: 'left', version: '1.0.0', ...contribution },
          { id: 'right', version: '1.0.0', ...contribution },
        ]),
      ).toThrow(/Duplicate/);
  });
  it('requires an explicit permission or null on every public route', () => {
    const plugin = (requiredPermission: unknown) =>
      ({
        id: 'fixture',
        version: '1.0.0',
        routes: [
          {
            operationId: 'fixture',
            method: 'GET',
            path: '/fixture',
            ...(requiredPermission === undefined ? {} : { requiredPermission }),
          },
        ],
      }) as PluginManifest;
    expect(() => graph([plugin(undefined)])).toThrow(/must declare requiredPermission/);
    expect(() => graph([plugin(' ')])).toThrow(/blank requiredPermission/);
    expect(graph([plugin(null)]).plugins[0]?.descriptor.routes?.[0]?.requiredPermission).toBeNull();
  });
});
