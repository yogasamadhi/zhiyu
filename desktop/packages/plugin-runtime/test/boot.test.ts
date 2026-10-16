import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootPlugins } from '../src/boot.js';
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include';
import { type Context } from '@deepseek-ai/cordis';

declare module '@deepseek-ai/cordis' {
  interface Context {
    fixtureValue: string;
    fixtureAbsent: string;
  }
}

describe('DSH Cordis plugin boot', () => {
  it('activates consumers by injected service availability rather than row order', async () => {
    const seen: string[] = [];
    const ctx = await bootPlugins({
      entries: [
        { id: 'consumer', name: 'cordis:consumer' },
        { id: 'provider', name: 'cordis:provider' },
      ],
      builtins: {
        consumer: {
          inject: ['fixtureValue'],
          apply(ctx: Context) {
            seen.push(ctx.fixtureValue);
          },
        },
        provider(ctx: Context) {
          ctx.provide('fixtureValue', 'ready');
        },
      },
    });
    try {
      expect(seen).toEqual(['ready']);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it('rejects a settled tree with missing injections and disposes active siblings', async () => {
    const cleaned: string[] = [];
    await expect(
      bootPlugins({
        entries: [
          { id: 'provider', name: 'cordis:provider' },
          { id: 'pending', name: 'cordis:pending' },
        ],
        builtins: {
          provider(ctx: Context) {
            ctx.effect(() => async () => {
              await Promise.resolve();
              cleaned.push('provider');
            });
          },
          pending: {
            inject: ['fixtureAbsent'],
            apply() {
              throw new Error('must remain pending');
            },
          },
        },
      }),
    ).rejects.toThrow(/pending.*missing services: fixtureAbsent/);
    expect(cleaned).toEqual(['provider']);
  });

  it('preserves activation errors and waits for partial async resource cleanup', async () => {
    const cause = new Error('fixture initialization failed');
    const cleaned: string[] = [];
    let failure: unknown;
    try {
      await bootPlugins({
        entries: [{ id: 'failed', name: 'cordis:failed' }],
        builtins: {
          async failed(ctx: Context) {
            await ctx.effect(async function* () {
              yield async () => {
                await Promise.resolve();
                cleaned.push('released');
              };
              throw cause;
            });
          },
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('fixture initialization failed');
    expect((failure as Error).cause).toBe(cause);
    expect(cleaned).toEqual(['released']);
  });

  it('loads packaged YAML through Include, uses DSH config replacement, and never writes back', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zhiyun-cordis-'));
    const path = join(directory, 'cordis.yml');
    const source = '- id: fixture\n  name: cordis:fixture\n  config: { first: 1, second: 2 }\n';
    await writeFile(path, source);
    let received: unknown;
    const ctx = await bootPlugins({
      path,
      patches: [{ id: 'fixture', config: { first: 3 } }],
      builtins: {
        fixture(_ctx: Context, config: unknown) {
          received = config;
        },
      },
    });
    try {
      expect(received).toEqual({ first: 3 });
      const entry = [...ctx.loader.entries()].find(
        ({ options }) => options.name === 'cordis:fixture',
      )!;
      await entry.update({ config: { first: 4 } });
      await ctx.loader.await();
    } finally {
      await ctx.fiber.dispose();
    }
    try {
      expect(await readFile(path, 'utf8')).toBe(source);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects unpackaged modules and performs idempotent root disposal', async () => {
    await expect(
      bootPlugins({ entries: [{ id: 'unknown', name: 'file:///unpackaged.js' }], builtins: {} }),
    ).rejects.toThrow(/Unknown packaged plugin/);
    let releases = 0;
    const ctx = await bootPlugins({
      entries: [{ id: 'fixture', name: 'cordis:fixture' }],
      builtins: {
        fixture(ctx: Context) {
          ctx.effect(() => () => {
            releases++;
          });
        },
      },
    });
    await Promise.all([ctx.fiber.dispose(), ctx.fiber.dispose()]);
    expect(releases).toBe(1);
  });

  it('retains DSH whole-config replacement for bundle and profile patch layers', () => {
    const first = applyEntryPatches(
      [],
      [{ insert: [{ id: 'fixture', name: 'cordis:fixture', config: { first: 1, second: 2 } }] }],
      () => {},
    );
    expect(
      applyEntryPatches(first, [{ id: 'fixture', config: { first: 3 } }], () => {})[0]?.config,
    ).toEqual({ first: 3 });
    expect(first[0]?.config).toEqual({ first: 1, second: 2 });
  });
  it('rejects duplicate services with both provider diagnostics and releases siblings', async () => {
    let released = false;
    const provider = (ctx: Context) => {
      ctx.effect(() => () => {
        released = true;
      });
      ctx.provide('fixtureValue', 'value');
    };
    await expect(
      bootPlugins({
        entries: [
          { id: 'first', name: 'cordis:first' },
          { id: 'second', name: 'cordis:second' },
        ],
        builtins: { first: provider, second: provider },
      }),
    ).rejects.toThrow(/second.*fixtureValue.*registered/s);
    expect(released).toBe(true);
  });
});
