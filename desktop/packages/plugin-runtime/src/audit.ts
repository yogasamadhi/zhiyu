import type { ResolvedGraph } from './catalog.js';
import { type Context, FiberState } from '@deepseek-ai/cordis';
/** Loader.await settles failures too; readiness requires an explicit audit. */
export async function assertPluginsActive(ctx: Context): Promise<void> {
  const failures: string[] = [];
  const causes: unknown[] = [];
  for (const entry of ctx.loader.entries()) {
    if (entry.disabled) continue;
    const fiber = entry.fiber;
    if (fiber?.state === FiberState.ACTIVE) continue;
    let detail = '';
    if (fiber?.state === FiberState.FAILED) {
      try {
        await fiber.await();
      } catch (cause) {
        causes.push(cause);
        detail = `; ${cause instanceof Error ? cause.message : String(cause)}`;
      }
    }
    const missing = fiber ? Object.keys(fiber.inject).filter((key) => !ctx.get(key)) : [];
    failures.push(
      `${entry.id} (${entry.options.name}): ${fiber ? FiberState[fiber.state] : 'import failed'}${missing.length ? `; missing services: ${missing.join(', ')}` : ''}${detail}`,
    );
  }
  if (failures.length)
    throw new Error(`Plugin startup failed:\n${failures.join('\n')}`, {
      cause:
        causes.length === 1 ? causes[0] : new AggregateError(causes, 'Plugin activation failures'),
    });
}

/** Static service IDs remain compatible; implementations live in Cordis. */
export function assertPublishedServices(ctx: Context, graph: ResolvedGraph): void {
  for (const { descriptor } of graph.plugins) {
    for (const service of descriptor.providedServices ?? []) {
      if (ctx.get(service.id) === undefined)
        throw new Error(`Plugin ${descriptor.id} did not publish declared service ${service.id}`);
    }
  }
}
