import type { Context } from '@deepseek-ai/cordis';
import type { ResolvedGraph } from '@zhiyun/plugin-runtime';
import LoggerConsole from '@deepseek-ai/cordis-plugin-logger-console';
import Timer from '@deepseek-ai/cordis-plugin-timer';
import type { AnalyticsWorkerClient } from '@zhiyun/analytics-worker-client';
import type { HostCapabilities, SchedulingEnvironment } from '@zhiyun/contracts';
import ai_assistance from '@zhiyun/plugin-ai-assistance';
import analytics from '@zhiyun/plugin-analytics';
import collection from '@zhiyun/plugin-collection';
import corpus from '@zhiyun/plugin-corpus';
import datasets from '@zhiyun/plugin-datasets';
import identity from '@zhiyun/plugin-identity';
import monitoring from '@zhiyun/plugin-monitoring';
import outputs from '@zhiyun/plugin-outputs';
import platform from '@zhiyun/plugin-platform';
import preferences from '@zhiyun/plugin-preferences';
import recruitment from '@zhiyun/plugin-recruitment';
import { bootPlugins, assertPublishedServices } from '@zhiyun/plugin-runtime';
import templates from '@zhiyun/plugin-templates';
import { composeProductProfile, resolveProductGraph } from '@zhiyun/product-profiles';
import { RuntimeRoutes, type Level2RuntimeDependencies } from '@zhiyun/runtime-contracts';
import {
  buildRuntimeGateway,
  type RuntimeGateway,
  type RuntimeGatewayOptions,
} from '@zhiyun/runtime-gateway';
export type {
  Level2RuntimeDependencies,
  Level2RuntimeRepositories,
} from '@zhiyun/runtime-contracts';
export type Level2RuntimeOptions = RuntimeGatewayOptions;

export interface Level2Runtime extends RuntimeGateway {
  setSchedulingEnvironment(environment: SchedulingEnvironment): Promise<void>;
  setAnalyticsWorker(
    worker: AnalyticsWorkerClient | undefined,
    status: HostCapabilities['metadata']['analyticsWorkerStatus'],
  ): void;
}

export async function buildLevel2Runtime(
  dependencies: Level2RuntimeDependencies,
  options: Level2RuntimeOptions,
): Promise<Level2Runtime> {
  return buildRuntimeFromResources(() => Promise.resolve(dependencies), options);
}
export async function buildRuntimeFromResources(
  createResources: (
    ctx: Context,
    close: (resource: { close(): Promise<void> }) => Promise<void>,
    graph: ResolvedGraph,
  ) => Promise<Level2RuntimeDependencies>,
  options: Level2RuntimeOptions,
): Promise<Level2Runtime> {
  let dependencies!: Level2RuntimeDependencies;
  const graph = resolveProductGraph(options.profileId);
  const composition = composeProductProfile(options.profileId);
  const identityEnabled = graph.plugins.some(({ descriptor }) => descriptor.id === 'identity');

  const routes = new RuntimeRoutes();
  const closed = new WeakMap<object, Promise<void>>();
  function closeRepository(repository: { close(): Promise<void> }): Promise<void> {
    let task = closed.get(repository);
    if (!task) {
      task = Promise.resolve().then(() => repository.close());
      closed.set(repository, task);
    }
    return task;
  }
  let jobsClose: Promise<void> | undefined;
  const closeJobs = () => (jobsClose ??= closeRepository(dependencies.jobs));
  const ctx = await bootPlugins({
    builtins: {
      platform: platform,
      datasets: datasets,
      collection: collection,
      monitoring: monitoring,
      templates: templates,
      outputs: outputs,
      preferences: preferences,
      recruitment: recruitment,
      analytics: analytics,
      corpus: corpus,
      'ai-assistance': ai_assistance,
      identity: identity,
      timer: Timer,
      logger: LoggerConsole,
    },
    path: composition.path,
    patches: composition.patches,
    async prepare(root) {
      await root
        .plugin(async (ctx) => {
          dependencies = await createResources(ctx, closeRepository, graph);
          ctx.effect(() => () => closeJobs(), 'host-job-queue');
          ctx.effect(
            () => async () => {
              const result = await Promise.allSettled(
                [
                  dependencies.artifactStore,
                  ...Object.values(dependencies.repositories),
                  ...(dependencies.identity ? [dependencies.identity.repository] : []),
                ].map(closeRepository),
              );
              const failures = result
                .filter((item): item is PromiseRejectedResult => item.status === 'rejected')
                .map((item) => item.reason as unknown);
              if (failures.length) throw new AggregateError(failures, 'Repository cleanup failed');
            },
            'host-repositories',
          );
          if (identityEnabled !== Boolean(dependencies.identity))
            throw new Error(
              identityEnabled
                ? 'Headless Identity is enabled but its SQLite repository and configuration are missing'
                : 'Identity dependencies may only be supplied to the Headless Identity profile',
            );
          ctx.provide('runtimeHost', {
            dependencies,
            options,
            graph,
            routes,
            closeRepository,
            closeJobs,
          });
        })
        .await();
    },
  });
  let stoppingTask: Promise<void> | undefined;
  const stopPluginWork = () => (stoppingTask ??= ctx.parallel('runtime/stopping'));
  let shutdownTask: Promise<void> | undefined;
  const shutdownPlugins = () =>
    (shutdownTask ??= (async () => {
      try {
        await stopPluginWork();
      } finally {
        try {
          await closeJobs();
        } finally {
          await ctx.fiber.dispose();
        }
      }
    })());
  try {
    assertPublishedServices(ctx, graph);
    const gateway = await buildRuntimeGateway(
      {
        platform: dependencies.repositories.platform,
        artifactStore: dependencies.artifactStore,
        jobs: dependencies.jobs,
        pluginContext: ctx,
        shutdownPlugins,
        stopPluginWork,
        migrations: [],
        registerPluginHttp: (app) => routes.install(app),
        realtime: ctx.realtime,
        recordExperienceEntry: ctx.recordExperienceEntry,
        metadata: dependencies.host.metadata,
        capabilities: dependencies.host.capabilities,
        openApiDocument: dependencies.openApiDocument,
        ...(dependencies.readiness ? { readiness: dependencies.readiness } : {}),
        ...(ctx.get('authenticateDataToken')
          ? { authenticateDataToken: ctx.authenticateDataToken }
          : {}),
        ...(ctx.get('workspaceAuthorization')
          ? { workspaceAuthorization: ctx.workspaceAuthorization }
          : {}),
        ...(dependencies.host.saveArtifact
          ? {
              saveArtifact: (artifact) =>
                dependencies.host.saveArtifact!(
                  {
                    id: artifact.id,
                    runId:
                      typeof artifact.metadata.runId === 'string'
                        ? artifact.metadata.runId
                        : artifact.id,
                    format: artifact.filename.toLowerCase().endsWith('.csv')
                      ? 'csv'
                      : artifact.filename.toLowerCase().endsWith('.xlsx')
                        ? 'xlsx'
                        : 'json',
                    filename: artifact.filename,
                    contentType: artifact.contentType,
                    size: artifact.size,
                    createdAt: artifact.createdAt,
                  },
                  { storageKey: artifact.storageKey },
                ),
            }
          : {}),
      },
      options,
    );
    return {
      ...gateway,
      setSchedulingEnvironment: (environment) =>
        ctx.collectionScheduler.setEnvironment(environment),
      setAnalyticsWorker(nextWorker, status) {
        ctx.worker.set(nextWorker);
        gateway.setAnalyticsWorkerStatus(status);
      },
    };
  } catch (error) {
    await shutdownPlugins().catch(() => {});
    throw error;
  }
}
