import { Context, type Plugin } from '@deepseek-ai/cordis';
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader';
import { assertPluginsActive } from './audit.js';

/** Client modules arrive from a packaged roster, as in DSH's client boot. */
export async function bootClientPlugins(options: {
  entries: readonly EntryOptions[];
  builtins: Readonly<Record<string, Plugin>>;
  prepare(ctx: Context): void | Promise<void>;
}): Promise<Context> {
  const ctx = new Context();
  try {
    await ctx.plugin(Loader).await();
    Object.assign(ctx.loader.builtins, options.builtins);
    await options.prepare(ctx);
    for (const entry of options.entries) {
      if (
        !entry.name.startsWith('cordis:') ||
        !Object.hasOwn(options.builtins, entry.name.slice(7))
      )
        throw new Error(`Unknown packaged client plugin: ${entry.name}`);
      await ctx.loader.create(entry);
    }
    await ctx.loader.await();
    await assertPluginsActive(ctx);
    return ctx;
  } catch (cause) {
    await ctx.fiber.dispose().catch(() => {});
    throw cause;
  }
}
