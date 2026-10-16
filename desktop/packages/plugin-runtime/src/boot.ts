import { pathToFileURL } from 'node:url';
import { assertPluginsActive } from './audit.js';
import { Context, type Plugin } from '@deepseek-ai/cordis';
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader';
import Include, { type PatchOptions } from '@deepseek-ai/cordis-plugin-include';
import Group from '@deepseek-ai/cordis-plugin-group';

/** Packaged configurations never write loader state into the installation. */
class PackagedInclude extends Include {
  override write() {}
  override import(name: string, getOuterStack?: () => string[]): unknown {
    if (!name.startsWith('cordis:') || !Object.hasOwn(this.ctx.loader.builtins, name.slice(7))) {
      throw new Error(`Unknown packaged plugin: ${name}`);
    }
    return super.import(name, getOuterStack);
  }
}

export interface PluginBootOptions {
  builtins: Readonly<Record<string, Plugin>>;
  path?: string;
  patches?: PatchOptions[];
  entries?: EntryOptions[];
  prepare?(ctx: Context): void | Promise<void>;
}

/** Cordis owns dependency activation and every plugin's effects. */
export async function bootPlugins(options: PluginBootOptions): Promise<Context> {
  const ctx = new Context();
  try {
    await ctx.plugin(Loader).await();
    Object.assign(ctx.loader.builtins, options.builtins, {
      include: PackagedInclude,
      group: Group,
    });
    await options.prepare?.(ctx);
    if (options.path) {
      const root: EntryOptions = {
        id: 'include',
        name: 'cordis:include',
        config: {
          path: options.path.startsWith('file:') ? options.path : pathToFileURL(options.path).href,
          patches: options.patches ?? [],
        },
      };
      await ctx.loader.create(root);
    } else {
      for (const entry of options.entries ?? []) {
        if (
          !entry.name.startsWith('cordis:') ||
          !Object.hasOwn(ctx.loader.builtins, entry.name.slice(7))
        )
          throw new Error(`Unknown packaged plugin: ${entry.name}`);
        await ctx.loader.create(entry);
      }
    }
    await ctx.loader.await();
    await assertPluginsActive(ctx);
    return ctx;
  } catch (cause) {
    await ctx.fiber.dispose().catch(() => {});
    throw cause;
  }
}
