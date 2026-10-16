import type {} from '@zhiyun/runtime-contracts';
import { type Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { preferenceImportSchema } from '@zhiyun/contracts';
import {
  TREND_SOURCE_CATALOG,
  buildPreferenceProfile,
  contentResolver,
  matchPreferenceTags,
  normalizeTrendRecords,
  preferenceContentFromResolved,
  sourceCatalogEntry,
} from '@zhiyun/preferences';
import { PreferencesHttpError, PreferencesService, registerPreferencesHttp } from './index.js';

export const inject = ['crawlerProvider', 'jobs', 'runtimeHost'];
export const Config = Schema.object({});
function createServices(ctx: Context) {
  const { dependencies } = ctx.runtimeHost;
  const repositories = dependencies.repositories;
  const trendInstallations = new Map<
    string,
    Promise<{
      taskId: string | null;
    }>
  >();
  const preferencesService = new PreferencesService(repositories.preferences);
  const installTrendSource = (
    key: string,
  ): Promise<{
    taskId: string | null;
  }> => {
    const active = trendInstallations.get(key);
    if (active) return active;
    const installation = (async () => {
      const entry = sourceCatalogEntry(key);
      if (!entry?.supported || !entry.task || !entry.plan) return { taskId: null };
      const binding = await repositories.preferences.getTrendSourceBinding(key);
      let task = binding?.taskId ? await repositories.collection.getTask(binding.taskId) : null;
      if (!task) {
        const page = await repositories.collection.listTasks(undefined, 1000);
        const reusable = page.items.find(
          (candidate) =>
            candidate.startUrl === entry.task!.startUrl && candidate.name === entry.task!.name,
        );
        task = reusable ? await repositories.collection.getTask(reusable.id) : null;
      }
      if (!task) {
        const { outputBindings, ...collectionInput } = entry.task;
        void outputBindings;
        const created = await repositories.collection.createTask(collectionInput);
        task = await repositories.collection.getTask(created.id);
      }
      if (!task) throw new Error(`Trend source ${key} could not create its Collection Task`);
      if (!task.activeRule) {
        await repositories.collection.createRule(
          task.id,
          `${entry.name}规则`,
          entry.plan,
          'system',
        );
      }
      return { taskId: task.id };
    })().finally(() => trendInstallations.delete(key));
    trendInstallations.set(key, installation);
    return installation;
  };
  const runTrendSource = async (key: string): Promise<Record<string, unknown>> => {
    const entry = sourceCatalogEntry(key);
    if (!entry?.supported) return { key, status: 'skipped', reason: 'unsupported' };
    let binding = await repositories.preferences.getTrendSourceBinding(key);
    if (binding && !binding.enabled) return { key, status: 'skipped', reason: 'disabled' };
    if (!binding?.taskId) {
      const installed = await installTrendSource(key);
      binding = await repositories.preferences.upsertTrendSourceBinding({
        key,
        platform: entry.platform,
        taskId: installed.taskId,
        enabled: binding?.enabled ?? true,
        autoRefresh: binding?.autoRefresh ?? true,
      });
    }
    if (!binding.taskId) return { key, status: 'skipped', reason: 'not-installed' };
    const active = (await repositories.collection.listRuns(binding.taskId)).find((run) =>
      ['queued', 'running', 'persisting'].includes(run.status),
    );
    if (active) {
      return { key, taskId: binding.taskId, runId: active.id, status: 'already-running' };
    }
    const run = await repositories.collection.createRun(binding.taskId);
    await ctx.jobs.enqueue({
      id: run.id,
      ownerPluginId: 'collection',
      type: 'collection.crawl.execute',
      resourceClass: 'browser-heavy',
      payload: { taskId: binding.taskId, runId: run.id },
      maxAttempts: 2,
    });
    return { key, taskId: binding.taskId, runId: run.id, status: 'queued' };
  };
  return { trendInstallations, preferencesService, installTrendSource, runTrendSource };
}
export type RuntimeServices = ReturnType<typeof createServices>;
type Services = RuntimeServices;
declare module '@deepseek-ai/cordis' {
  interface Context {
    trendInstallations: Services['trendInstallations'];
    preferencesService: Services['preferencesService'];
    installTrendSource: Services['installTrendSource'];
    runTrendSource: Services['runTrendSource'];
  }
}
export async function apply(ctx: Context) {
  const { dependencies } = ctx.runtimeHost;
  const repositories = dependencies.repositories;
  const repository = repositories.preferences;
  ctx.effect(() => () => ctx.runtimeHost.closeRepository(repository), 'preferences-storage');
  await repository.migrate();
  const services = createServices(ctx);
  ctx.provide('preferences.service', services.preferencesService);
  const { preferencesService, installTrendSource, runTrendSource } = services;
  ctx.provide('trendInstallations', services.trendInstallations);
  ctx.provide('preferencesService', services.preferencesService);
  ctx.provide('installTrendSource', services.installTrendSource);
  ctx.provide('runTrendSource', services.runTrendSource);

  ctx.effect(
    () =>
      ctx.runtimeHost.routes.register('preferences', async (app) => {
        await registerPreferencesHttp(app, {
          repository: repositories.preferences,
          service: preferencesService,
          bootstrapTrendSource: installTrendSource,
          runTrendSource,
          async trendItems() {
            const bindings = await repositories.preferences.listTrendSourceBindings();
            const groups = await Promise.all(
              bindings
                .filter((binding) => binding.enabled && binding.taskId)
                .map(async (binding) => {
                  const dataset = await repositories.datasets.getDatasetBySourceTask(
                    binding.taskId!,
                  );
                  if (!dataset) return [];
                  const page = await repositories.datasets.listRecords(dataset.id, undefined, 500, {
                    includeRemoved: false,
                  });
                  return normalizeTrendRecords(binding.key, page.items);
                }),
            );
            const signals = await preferencesService.listSignals(undefined, 10000);
            const profile = buildPreferenceProfile(signals.items);
            const order = new Map(TREND_SOURCE_CATALOG.map((entry, index) => [entry.key, index]));
            return matchPreferenceTags(groups.flat(), profile).sort(
              (left, right) =>
                (order.get(left.sourceKey) ?? 99) - (order.get(right.sourceKey) ?? 99) ||
                (left.rank ?? 999) - (right.rank ?? 999),
            );
          },
          async importPreference(body) {
            const input = preferenceImportSchema.parse(body);
            const resolver = contentResolver(input.url);
            if (!resolver) {
              throw new PreferencesHttpError(
                422,
                'NAVIGATION_ERROR',
                'Only supported public content links can be imported',
              );
            }
            const result = await ctx.crawlerProvider.crawl({
              url: resolver.crawlUrl ?? input.url,
              plan: resolver.plan,
              requestSettings: {
                headers: {},
                cookies: [],
                timeoutMs: 20000,
                retries: 0,
                retryBackoffMs: 1000,
                concurrency: 1,
                delayMs: 1500,
                maxRequests: 1,
                maxRuntimeMs: 30000,
                domainRateLimitPerMinute: 40,
                respectRobotsTxt: true,
                maxResponseBytes: 5 * 1024 * 1024,
                redirectLimit: 5,
                userAgent: 'Mozilla/5.0 (compatible; ZhiYun/1.0; public-metadata-crawl)',
              },
              browserSettings: { enabled: false, waitUntil: 'domcontentloaded', actions: [] },
              pagination: { type: 'none' },
              networkPolicy: { allowPrivateNetworks: false, allowedHosts: [], allowedCidrs: [] },
              previewLimit: 1,
            });
            const resolved = result.records[0];
            const finalResolver = resolved ? contentResolver(resolved.sourceUrl) : null;
            if (!resolved || !finalResolver || finalResolver.platform !== resolver.platform) {
              throw new PreferencesHttpError(
                422,
                'NAVIGATION_ERROR',
                'The URL did not resolve to supported public content metadata',
              );
            }
            const content = preferenceContentFromResolved(
              resolver.platform,
              resolved.data,
              resolved.sourceUrl,
            );
            if (!content) {
              throw new PreferencesHttpError(
                422,
                'EXTRACTION_ERROR',
                'Public content metadata could not be extracted',
              );
            }
            return preferencesService.setSignal({ kind: input.kind, content });
          },
        });
      }),
    'preferences-http',
  );
}
export default { inject, Config, apply };
