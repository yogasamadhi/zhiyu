import { describe, expect, it } from 'vitest';
import {
  activateGraph,
  createServiceToken,
  resolveAndActivateGraph,
  resolveGraph,
  type BundleDescriptor,
  type PluginDescriptor,
  type ProductProfile,
} from '../src/index.js';

const profile: ProductProfile = { id: 'test', version: '1.0.0', bundleIds: ['test'] };
const bundle: BundleDescriptor = { id: 'test', version: '1.0.0', pluginIds: ['consumer'] };

describe('Level 2 kernel', () => {
  it('resolves dependencies before consumers and creates a stable revision', () => {
    const service = createServiceToken<string>('test.value', '1.0.0', 'provider');
    const provider: PluginDescriptor = {
      id: 'provider',
      version: '1.0.0',
      providedServices: [service],
      activate(context) {
        context.services.provide(service, 'ready');
      },
    };
    const consumer: PluginDescriptor = {
      id: 'consumer',
      version: '1.0.0',
      dependencies: [{ id: 'provider', range: '^1.0.0' }],
      activate() {},
    };
    const first = resolveGraph({ profile, bundles: [bundle], plugins: [consumer, provider] });
    const second = resolveGraph({ profile, bundles: [bundle], plugins: [provider, consumer] });
    expect(first.plugins.map(({ descriptor }) => descriptor.id)).toEqual(['provider', 'consumer']);
    expect(first.revision).toBe(second.revision);
  });

  it('rejects cycles, missing plugins and duplicate owned contributions', () => {
    const left: PluginDescriptor = {
      id: 'left',
      version: '1.0.0',
      dependencies: [{ id: 'right' }],
      activate() {},
    };
    const right: PluginDescriptor = {
      id: 'right',
      version: '1.0.0',
      dependencies: [{ id: 'left' }],
      activate() {},
    };
    expect(() =>
      resolveGraph({
        profile,
        bundles: [{ ...bundle, pluginIds: ['left'] }],
        plugins: [left, right],
      }),
    ).toThrow(/cycle/);
    expect(() => resolveGraph({ profile, bundles: [bundle], plugins: [] })).toThrow(
      /unknown plugin/,
    );
    expect(() =>
      resolveGraph({
        profile,
        bundles: [{ ...bundle, pluginIds: ['left', 'right'] }],
        plugins: [
          {
            ...left,
            dependencies: [],
            routes: [
              {
                operationId: 'duplicate',
                method: 'GET',
                path: '/a',
                requiredPermission: 'workspace.read',
              },
            ],
          },
          {
            ...right,
            dependencies: [],
            routes: [
              {
                operationId: 'duplicate',
                method: 'GET',
                path: '/b',
                requiredPermission: 'workspace.read',
              },
            ],
          },
        ],
      }),
    ).toThrow(/Duplicate operation/);
  });

  it('requires every route to explicitly declare a non-blank permission or null', () => {
    const invalid = (requiredPermission: unknown): PluginDescriptor =>
      ({
        id: 'consumer',
        version: '1.0.0',
        routes: [
          {
            operationId: 'readThing',
            method: 'GET',
            path: '/thing',
            ...(requiredPermission === undefined ? {} : { requiredPermission }),
          },
        ],
        activate() {},
      }) as PluginDescriptor;

    expect(() =>
      resolveGraph({ profile, bundles: [bundle], plugins: [invalid(undefined)] }),
    ).toThrow(/must declare requiredPermission/);
    expect(() => resolveGraph({ profile, bundles: [bundle], plugins: [invalid('   ')] })).toThrow(
      /blank requiredPermission/,
    );

    const publicPlugin = invalid(null);
    const graph = resolveGraph({ profile, bundles: [bundle], plugins: [publicPlugin] });
    expect(graph.plugins[0]?.descriptor.routes?.[0]?.requiredPermission).toBeNull();
  });

  it('provides typed services and disposes effects in reverse order', async () => {
    const order: string[] = [];
    const service = createServiceToken<{ value: number }>('test.value', '1.0.0', 'provider');
    const provider: PluginDescriptor = {
      id: 'provider',
      version: '1.0.0',
      providedServices: [service],
      activate(context) {
        context.services.provide(service, { value: 42 });
        return context.effect('provider', () => () => {
          order.push('provider');
        });
      },
    };
    const consumer: PluginDescriptor = {
      id: 'consumer',
      version: '1.0.0',
      dependencies: [{ id: 'provider' }],
      async activate(context) {
        expect(context.services.require(service).value).toBe(42);
        await context.effect('consumer', () => () => {
          order.push('consumer');
        });
      },
    };
    const active = await resolveAndActivateGraph({
      profile,
      bundles: [bundle],
      plugins: [consumer, provider],
    });
    expect(active.effects.list()).toHaveLength(2);
    await active.dispose();
    expect(order).toEqual(['consumer', 'provider']);
    expect(active.effects.list()).toHaveLength(0);
  });

  it('rolls back acquired effects when activation fails', async () => {
    const order: string[] = [];
    const first: PluginDescriptor = {
      id: 'first',
      version: '1.0.0',
      async activate(context) {
        await context.effect('resource', () => () => {
          order.push('disposed');
        });
      },
    };
    const second: PluginDescriptor = {
      id: 'second',
      version: '1.0.0',
      dependencies: [{ id: 'first' }],
      activate() {
        throw new Error('activation failed');
      },
    };
    const graph = resolveGraph({
      profile,
      bundles: [{ ...bundle, pluginIds: ['second'] }],
      plugins: [first, second],
    });
    await expect(activateGraph(graph)).rejects.toThrow('activation failed');
    expect(order).toEqual(['disposed']);
  });
});
