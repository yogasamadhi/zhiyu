import type {} from '@zhiyun/runtime-contracts';
import { type Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { RealtimeEventHub } from '@zhiyun/runtime-gateway';
import { MutableAnalyticsWorker } from './analytics-worker-adapter.js';

export const inject = ['runtimeHost'];
export const Config = Schema.object({});
function createServices(ctx: Context) {
  const { dependencies } = ctx.runtimeHost;
  const realtime = new RealtimeEventHub();
  const worker = new MutableAnalyticsWorker(dependencies.analyticsWorker);
  return { realtime, worker };
}
export type RuntimeServices = ReturnType<typeof createServices>;
type Services = RuntimeServices;
declare module '@deepseek-ai/cordis' {
  interface Context {
    realtime: Services['realtime'];
    worker: Services['worker'];
  }
}
export async function apply(ctx: Context) {
  const { dependencies } = ctx.runtimeHost;
  const repositories = dependencies.repositories;
  ctx.effect(
    () => () => ctx.runtimeHost.closeRepository(repositories.platform),
    'platform-storage',
  );
  await repositories.platform.initialize(ctx.runtimeHost.graph.revision);
  ctx.effect(
    () => () => ctx.runtimeHost.closeRepository(dependencies.artifactStore),
    'artifact-store',
  );
  await dependencies.artifactStore.initialize();
  ctx.provide('jobs', dependencies.jobs);
  ctx.provide('jobHandlers', dependencies.handlers);
  ctx.provide('artifacts', dependencies.artifactStore);
  ctx.provide('credentials', dependencies.credentialStore);
  ctx.provide('hostCapabilities', dependencies.host);
  ctx.provide('crawlerProvider', dependencies.crawler);
  ctx.provide('aiProvider', dependencies.ai);
  const services = createServices(ctx);
  ctx.provide('platform.repository', repositories.platform);
  ctx.provide('artifact.store', dependencies.artifactStore);

  ctx.provide('realtime', services.realtime);
  ctx.provide('worker', services.worker);

  ctx.effect(() => () => ctx.runtimeHost.closeJobs(), 'job-queue');
}
export default { inject, Config, apply };
