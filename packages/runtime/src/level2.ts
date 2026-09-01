import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AnalyticsWorkerClient } from '@zhiyun/analytics-worker-client';
import type {
  AiProvider,
  CrawlerService,
  CredentialStore,
  HostCapabilities,
} from '@zhiyun/contracts';
import { preferenceImportSchema } from '@zhiyun/contracts';
import type {
  ArtifactStore,
  JobHandlerRegistry,
  PlatformJobQueue,
  PlatformRepository,
} from '@zhiyun/platform-core';
import {
  TREND_SOURCE_CATALOG,
  buildPreferenceProfile,
  contentResolver,
  matchPreferenceTags,
  normalizeTrendRecords,
  preferenceContentFromResolved,
  sourceCatalogEntry,
} from '@zhiyun/preferences';
import { resolveProductGraph } from '@zhiyun/product-profiles';
import {
  AiAssistanceService,
  AiProviderSettingsService,
  AnonymousBrowserWebSearch,
  CrawlerAssistantService,
  MutableAiProvider,
  PiAgentRuntime,
  registerAiAssistanceHttp,
  type AiConversationRepository,
  type CollectionForAiPort,
} from '@zhiyun/plugin-ai-assistance';
import {
  AnalysisJobService,
  AnalysisRecipeService,
  AnalyticsCatalog,
  createAnalysisJobHandler,
  registerAnalyticsHttp,
  type AnalysisRepository,
  type AnalyticsWorkerControl,
} from '@zhiyun/plugin-analytics';
import {
  CollectionScheduler,
  CollectionService,
  createCollectionJobHandler,
  resolveCollectionTaskSettings,
  registerCollectionHttp,
  type CollectionRepository,
} from '@zhiyun/plugin-collection';
import {
  CorpusBuildService,
  CorpusRecipeService,
  CorpusService,
  createCorpusBuildHandler,
  registerCorpusHttp,
  type CorpusRepository,
  type CorpusWorkerControl,
} from '@zhiyun/plugin-corpus';
import {
  DatasetSnapshotService,
  registerDatasetsHttp,
  type DatasetRepository,
  type SnapshotWorkerClient,
} from '@zhiyun/plugin-datasets';
import {
  IdentityError,
  IdentityService,
  registerIdentityHttp,
  rolePermissions,
  type IdentityPrincipal,
  type IdentityRepository,
  type IdentityServiceOptions,
} from '@zhiyun/plugin-identity';
import {
  OutputAttemptReplay,
  OutputEventNotificationOutbox,
  OutputsService,
  PlatformOutputArtifactStore,
  createEventNotificationJobHandler,
  createOutputDeliveryJobHandler,
  destinationReceivesRunData,
  enqueueOutputEventNotifications,
  enqueueOutputDelivery,
  registerOutputsHttp,
  type OutputRepository,
} from '@zhiyun/plugin-outputs';
import {
  MonitoringEvaluationOutbox,
  MonitoringService,
  createMonitoringEvaluationJobHandler,
  enqueueMonitoringEvaluation,
  registerMonitoringHttp,
  type MonitoringRepository,
} from '@zhiyun/plugin-monitoring';
import {
  PreferencesHttpError,
  PreferencesService,
  registerPreferencesHttp,
  type PreferencesRepository,
} from '@zhiyun/plugin-preferences';
import { registerTemplatesHttp } from '@zhiyun/plugin-templates';
import {
  buildRuntimeGateway,
  RealtimeEventHub,
  type RuntimeGateway,
  type RuntimeGatewayOptions,
  type RuntimeReadinessProbe,
} from '@zhiyun/runtime-gateway';
import { InspectionManager } from './inspection.js';

export interface Level2RuntimeRepositories {
  platform: PlatformRepository;
  collection: CollectionRepository;
  datasets: DatasetRepository;
  outputs: OutputRepository;
  preferences: PreferencesRepository;
  analytics: AnalysisRepository;
  corpus: CorpusRepository;
  aiAssistance: AiConversationRepository;
  monitoring: MonitoringRepository;
}

export interface Level2RuntimeDependencies {
  repositories: Level2RuntimeRepositories;
  artifactStore: ArtifactStore;
  jobs: PlatformJobQueue;
  handlers: JobHandlerRegistry;
  crawler: CrawlerService;
  ai: AiProvider;
  credentialStore: CredentialStore;
  analyticsWorker?: AnalyticsWorkerClient;
  host: HostCapabilities;
  openApiDocument: unknown;
  readiness?(): Promise<RuntimeReadinessProbe>;
  identity?: {
    repository: IdentityRepository;
    options: IdentityServiceOptions;
    secureCookies?: boolean;
  };
}

export type Level2RuntimeOptions = RuntimeGatewayOptions;

export interface Level2Runtime extends RuntimeGateway {
  setAnalyticsWorker(
    worker: AnalyticsWorkerClient | undefined,
    status: HostCapabilities['metadata']['analyticsWorkerStatus'],
  ): void;
}

class MutableAnalyticsWorker
  implements AnalyticsWorkerControl, CorpusWorkerControl, SnapshotWorkerClient
{
  constructor(private current: AnalyticsWorkerClient | undefined) {}

  available(): boolean {
    return Boolean(this.current);
  }

  set(worker: AnalyticsWorkerClient | undefined): void {
    this.current = worker;
  }

  private require(): AnalyticsWorkerClient {
    if (!this.current) throw new Error('ANALYTICS_UNAVAILABLE: Analytics Worker is unavailable');
    return this.current;
  }

  methods() {
    return this.require().methods();
  }

  version() {
    return this.require().version();
  }

  submit(input: Parameters<AnalyticsWorkerClient['submit']>[0]) {
    return this.require().submit(input);
  }

  job(jobId: string) {
    return this.require().job(jobId);
  }

  cancel(jobId: string) {
    return this.require().cancel(jobId);
  }
}

class AiConversationRetention {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly repository: AiConversationRepository) {}

  async start(): Promise<void> {
    await this.cleanup();
    this.timer = setInterval(() => void this.cleanup(), 24 * 60 * 60_000);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async cleanup(): Promise<void> {
    await this.repository.cleanupInactive(
      new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString(),
    );
  }
}

export async function buildLevel2Runtime(
  dependencies: Level2RuntimeDependencies,
  options: Level2RuntimeOptions,
): Promise<Level2Runtime> {
  const repositories = dependencies.repositories;
  const productGraph = resolveProductGraph(options.profileId);
  const aiEnabled = productGraph.plugins.some(
    ({ descriptor }) => descriptor.id === 'ai-assistance',
  );
  const identityEnabled = productGraph.plugins.some(
    ({ descriptor }) => descriptor.id === 'identity',
  );
  if (identityEnabled !== Boolean(dependencies.identity)) {
    throw new Error(
      identityEnabled
        ? 'Headless Identity is enabled but its PostgreSQL repository and configuration are missing'
        : 'Identity dependencies may only be supplied to the Headless Identity profile',
    );
  }
  const identity = dependencies.identity
    ? new IdentityService(dependencies.identity.repository, dependencies.identity.options)
    : undefined;
  const realtime = new RealtimeEventHub();
  const dataApiRateLimits = new Map<string, { window: number; count: number }>();
  const trendInstallations = new Map<string, Promise<{ taskId: string | null }>>();
  const worker = new MutableAnalyticsWorker(dependencies.analyticsWorker);
  const inspections = new InspectionManager();
  const snapshotService = new DatasetSnapshotService(
    repositories.datasets,
    repositories.platform,
    dependencies.artifactStore,
    worker,
  );
  const collectionService = new CollectionService(repositories.collection, {
    commitRunRecords: (input) => repositories.datasets.commitRunRecords(input),
  });
  const collectionScheduler = new CollectionScheduler(
    repositories.collection,
    repositories.platform,
    dependencies.jobs,
  );
  const outputsService = new OutputsService(repositories.outputs);
  const monitoring = new MonitoringService(repositories.monitoring, {
    async issue(evaluation, notification) {
      await enqueueOutputEventNotifications(
        { repository: repositories.outputs, jobs: dependencies.jobs },
        {
          eventId: notification.eventId,
          type: 'quality.issue.detected',
          occurredAt: notification.occurredAt,
          taskId: evaluation.taskId,
          runId: evaluation.runId,
          severity: notification.severity,
          payload: notification.payload,
        },
      );
      const qualityIssues = evaluation.issues.filter((issue) => issue.kind !== 'run-failed');
      if (qualityIssues.length > 0) {
        await dependencies.host.notify?.(
          '织云任务需要关注',
          qualityIssues
            .map((issue) => issue.message)
            .slice(0, 3)
            .join('；'),
        );
      }
    },
    async recovered(evaluation, notification) {
      await enqueueOutputEventNotifications(
        { repository: repositories.outputs, jobs: dependencies.jobs },
        {
          eventId: notification.eventId,
          type: 'quality.recovered',
          occurredAt: notification.occurredAt,
          taskId: evaluation.taskId,
          runId: evaluation.runId,
          severity: 'info',
          payload: notification.payload,
        },
      );
      await dependencies.host.notify?.(
        '织云任务已恢复',
        `任务 ${evaluation.taskId} 的运行 ${evaluation.runId} 已恢复健康`,
      );
    },
  });
  const preferencesService = new PreferencesService(repositories.preferences);
  const analyticsCatalog = new AnalyticsCatalog(() => (worker.available() ? worker : undefined));
  const analysisRecipes = new AnalysisRecipeService(repositories.analytics, analyticsCatalog);
  const analysisJobs = new AnalysisJobService(
    repositories.analytics,
    repositories.platform,
    repositories.datasets,
    analyticsCatalog,
    dependencies.jobs,
  );
  const corpora = new CorpusService(repositories.corpus);
  const corpusRecipes = new CorpusRecipeService(repositories.corpus);
  const corpusBuilds = new CorpusBuildService(
    repositories.corpus,
    repositories.platform,
    repositories.datasets,
    () => worker.available(),
    dependencies.jobs,
  );
  const mutableAi = new MutableAiProvider(dependencies.ai);
  const collectionForAi: CollectionForAiPort = {
    async getTask(id) {
      const task = await repositories.collection.getTask(id);
      if (!task) return null;
      const settings = await resolveCollectionTaskSettings(
        task.requestSettings,
        task.browserSettings,
        task.credentialBindings,
        dependencies.credentialStore,
      );
      return { ...task, ...settings };
    },
    getRun: (id) => repositories.collection.getRun(id),
    async getRule(taskId, ruleId) {
      const rule = (await repositories.collection.listRules(taskId)).find(
        (candidate) => candidate.id === ruleId,
      );
      return rule ?? null;
    },
    async getActiveRule(taskId) {
      const active = await repositories.collection.getActiveRule(taskId);
      return active
        ? { activeVersionId: active.rule.activeVersionId, versions: [active.version] }
        : null;
    },
    createRuleVersion: (taskId, ruleId, definition) =>
      repositories.collection.createRuleVersion(taskId, ruleId, definition, 'ai'),
    createRepairProposal: (input) => repositories.collection.createRuleRepairProposal(input),
    listRepairProposals: (ruleId) => repositories.collection.listRuleRepairProposals(ruleId),
    markRepairProposalTested: (id) => repositories.collection.markRuleRepairProposalTested(id),
    updateRepairProposal: (id, status) =>
      repositories.collection.updateRuleRepairProposal(id, status),
    createTaskWithInitialRule: (input) => repositories.collection.createTaskWithInitialRule(input),
  };
  const aiAssistance = new AiAssistanceService(collectionForAi, mutableAi, dependencies.crawler);
  const crawlerAssistant = new CrawlerAssistantService({
    repository: repositories.aiAssistance,
    collection: collectionForAi,
    agent: new PiAgentRuntime(() => mutableAi.current()),
    provider: () => mutableAi.current(),
    providerConfigured: () => mutableAi.configured(),
    crawler: dependencies.crawler,
    search: new AnonymousBrowserWebSearch(),
    jobs: dependencies.jobs,
    realtime: { publish: (type, payload) => realtime.publish(type, payload) },
  });
  const providerSettings = new AiProviderSettingsService({
    repository: repositories.aiAssistance,
    provider: mutableAi,
    credentials: dependencies.credentialStore,
    mode: dependencies.host.metadata.mode,
    headlessConfigured:
      dependencies.host.metadata.mode === 'headless' && dependencies.ai.name !== 'mock',
    onUsage: async (usage) => {
      await repositories.platform
        .appendEvent({
          type: 'ai.request.completed',
          producerPluginId: 'ai-assistance',
          aggregateType: usage.taskId ? 'task' : 'runtime',
          aggregateId: usage.taskId ?? dependencies.host.metadata.runtimeId,
          payload: { ...usage },
        })
        .catch(() => undefined);
    },
    ...(dependencies.host.promptCredential
      ? {
          promptCredential: () => dependencies.host.promptCredential!('ai-api-key'),
        }
      : {}),
  });

  dependencies.handlers.register({
    type: 'collection.crawl.execute',
    ownerPluginId: 'collection',
    resourceClass: 'browser-heavy',
    handler: createCollectionJobHandler({
      repository: repositories.collection,
      service: collectionService,
      crawler: dependencies.crawler,
      credentialStore: dependencies.credentialStore,
      async afterSucceeded({ task, run }) {
        await enqueueMonitoringEvaluation(dependencies.jobs, {
          taskId: task.id,
          runId: run.id,
          outcome: 'succeeded',
        }).catch(async (error) => {
          await repositories.collection
            .appendRunLog({
              runId: run.id,
              level: 'warn',
              phase: 'monitoring',
              message: `Quality evaluation could not be queued: ${error instanceof Error ? error.message : String(error)}`,
              url: null,
              errorCode: 'MONITORING_ERROR',
              metadata: {},
            })
            .catch(() => undefined);
        });
        const succeededEvent = await repositories.platform.appendEvent({
          type: 'run.succeeded',
          producerPluginId: 'collection',
          aggregateType: 'run',
          aggregateId: run.id,
          payload: {
            taskId: task.id,
            runId: run.id,
            recordCount: run.recordCount,
            datasetStats: run.datasetStats,
          },
        });
        await enqueueOutputEventNotifications(
          { repository: repositories.outputs, jobs: dependencies.jobs },
          {
            eventId: succeededEvent.id,
            type: 'run.succeeded',
            occurredAt: succeededEvent.occurredAt,
            taskId: task.id,
            runId: run.id,
            severity: 'info',
            payload: succeededEvent.payload,
          },
        ).catch(() => undefined);
        if (run.datasetStats.added + run.datasetStats.updated + run.datasetStats.removed > 0) {
          const changedEvent = await repositories.platform.appendEvent({
            type: 'dataset.changed',
            producerPluginId: 'datasets',
            aggregateType: 'run',
            aggregateId: run.id,
            payload: {
              taskId: task.id,
              runId: run.id,
              changes: run.datasetStats,
            },
          });
          await enqueueOutputEventNotifications(
            { repository: repositories.outputs, jobs: dependencies.jobs },
            {
              eventId: changedEvent.id,
              type: 'dataset.changed',
              occurredAt: changedEvent.occurredAt,
              taskId: task.id,
              runId: run.id,
              severity: 'info',
              payload: changedEvent.payload,
            },
          ).catch(() => undefined);
        }
        const existing = new Map(
          (await repositories.outputs.listDeliveryAttempts(run.id)).map((attempt) => [
            attempt.destinationId,
            attempt,
          ]),
        );
        for (const destinationId of await repositories.outputs.listTaskBindings(task.id)) {
          const destination = await repositories.outputs.getDestination(destinationId);
          if (!destinationReceivesRunData(destination)) continue;
          const attempt =
            existing.get(destinationId) ??
            (await repositories.outputs.createDeliveryAttempt({
              destinationId,
              taskId: task.id,
              runId: run.id,
            }));
          if (attempt.status !== 'succeeded') {
            await enqueueOutputDelivery(dependencies.jobs, attempt);
          }
        }
      },
      async afterFailed({ task, run }) {
        const failedEvent = await repositories.platform.appendEvent({
          type: 'run.failed',
          producerPluginId: 'collection',
          aggregateType: 'run',
          aggregateId: run.id,
          payload: { taskId: task.id, runId: run.id, error: run.error },
        });
        await enqueueOutputEventNotifications(
          { repository: repositories.outputs, jobs: dependencies.jobs },
          {
            eventId: failedEvent.id,
            type: 'run.failed',
            occurredAt: failedEvent.occurredAt,
            taskId: task.id,
            runId: run.id,
            severity: 'error',
            payload: failedEvent.payload,
          },
        ).catch(() => undefined);
        await enqueueMonitoringEvaluation(dependencies.jobs, {
          taskId: task.id,
          runId: run.id,
          outcome: 'failed',
        }).catch(() => undefined);
        await dependencies.host
          .notify?.('织云任务运行失败', run.error ?? `任务 ${task.name} 运行失败`)
          .catch(() => undefined);
      },
    }),
  });
  dependencies.handlers.register({
    type: 'monitoring.quality.evaluate',
    ownerPluginId: 'monitoring',
    resourceClass: 'io',
    handler: createMonitoringEvaluationJobHandler({
      service: monitoring,
      collection: repositories.collection,
      datasets: repositories.datasets,
    }),
  });
  if (aiEnabled) {
    dependencies.handlers.register({
      type: 'ai.conversation.turn',
      ownerPluginId: 'ai-assistance',
      resourceClass: 'browser-heavy',
      handler: crawlerAssistant.createTurnJobHandler(),
    });
  }

  const installTrendSource = (key: string): Promise<{ taskId: string | null }> => {
    const active = trendInstallations.get(key);
    if (active) return active;
    const installation = (async () => {
      const entry = sourceCatalogEntry(key);
      if (!entry?.supported || !entry.task || !entry.plan) return { taskId: null };
      const binding = await repositories.preferences.getTrendSourceBinding(key);
      let task = binding?.taskId ? await repositories.collection.getTask(binding.taskId) : null;
      if (!task) {
        const page = await repositories.collection.listTasks(undefined, 1_000);
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
    await dependencies.jobs.enqueue({
      id: run.id,
      ownerPluginId: 'collection',
      type: 'collection.crawl.execute',
      resourceClass: 'browser-heavy',
      payload: { taskId: binding.taskId, runId: run.id },
      maxAttempts: 2,
    });
    return { key, taskId: binding.taskId, runId: run.id, status: 'queued' };
  };
  dependencies.handlers.register({
    type: 'outputs.delivery.execute',
    ownerPluginId: 'outputs',
    resourceClass: 'delivery',
    handler: createOutputDeliveryJobHandler({
      repository: repositories.outputs,
      tasks: repositories.collection,
      datasets: repositories.datasets,
      credentials: dependencies.credentialStore,
      artifacts: new PlatformOutputArtifactStore(dependencies.artifactStore, {
        parquetWorker: worker,
      }),
    }),
  });
  dependencies.handlers.register({
    type: 'outputs.event-notification.execute',
    ownerPluginId: 'outputs',
    resourceClass: 'delivery',
    handler: createEventNotificationJobHandler({
      repository: repositories.outputs,
      credentials: dependencies.credentialStore,
    }),
  });
  dependencies.handlers.register({
    type: 'analytics.job.execute',
    ownerPluginId: 'analytics',
    resourceClass: 'python-heavy',
    handler: createAnalysisJobHandler({
      repository: repositories.analytics,
      platform: repositories.platform,
      snapshots: repositories.datasets,
      artifactStore: dependencies.artifactStore,
      worker,
    }),
  });
  dependencies.handlers.register({
    type: 'corpus.build.execute',
    ownerPluginId: 'corpus',
    resourceClass: 'python-heavy',
    handler: createCorpusBuildHandler({
      repository: repositories.corpus,
      platform: repositories.platform,
      snapshots: repositories.datasets,
      artifactStore: dependencies.artifactStore,
      worker,
    }),
  });

  const registerPluginHttp = async (app: FastifyInstance) => {
    if (identity && dependencies.identity) {
      await registerIdentityHttp(app, identity, {
        ...(dependencies.identity.secureCookies === undefined
          ? {}
          : { secureCookies: dependencies.identity.secureCookies }),
      });
    }
    await registerDatasetsHttp(app, {
      repository: repositories.datasets,
      snapshots: snapshotService,
      platform: repositories.platform,
      artifactStore: dependencies.artifactStore,
    });
    await registerCollectionHttp(app, {
      repository: repositories.collection,
      platform: repositories.platform,
      jobs: dependencies.jobs,
      bindings: {
        list: (taskId) => repositories.outputs.listTaskBindings(taskId),
        replace: (taskId, destinationIds) => outputsService.bindTask(taskId, destinationIds),
        clear: async (taskId) => {
          await outputsService.clearCollectionTask(taskId);
        },
      },
      cleanup: [
        {
          clearTask: async (taskId) => {
            await preferencesService.clearCollectionTaskReference(taskId);
          },
        },
        { clearTask: (taskId) => repositories.monitoring.deleteTask(taskId) },
      ],
      credentialStore: dependencies.credentialStore,
      runtimeMode: dependencies.host.metadata.mode,
      ...(dependencies.host.promptCredential
        ? { promptCredential: dependencies.host.promptCredential.bind(dependencies.host) }
        : {}),
      ...(dependencies.host.createLoginSession
        ? { createLoginSession: dependencies.host.createLoginSession.bind(dependencies.host) }
        : {}),
      inspection: {
        async create(task) {
          const settings = await resolveCollectionTaskSettings(
            task.requestSettings,
            task.browserSettings,
            task.credentialBindings,
            dependencies.credentialStore,
          );
          return inspections.create({
            url: task.startUrl,
            requestSettings: settings.requestSettings,
            browserSettings: settings.browserSettings,
            networkPolicy: task.networkPolicy,
          });
        },
        screenshot: (id) => inspections.screenshot(id),
        action: (id, input) => inspections.action(id, input),
        step: (id, input) => inspections.step(id, input),
        select: (id, x, y) => inspections.select(id, x, y),
        close: (id) => inspections.close(id),
      },
      async previewRule(task, definition, limit) {
        const settings = await resolveCollectionTaskSettings(
          task.requestSettings,
          task.browserSettings,
          task.credentialBindings,
          dependencies.credentialStore,
        );
        return dependencies.crawler.crawl({
          url: task.startUrl,
          plan: definition,
          requestSettings: settings.requestSettings,
          browserSettings: settings.browserSettings,
          pagination: task.pagination,
          networkPolicy: task.networkPolicy,
          previewLimit: limit,
        });
      },
    });
    await registerOutputsHttp(app, {
      repository: repositories.outputs,
      jobs: dependencies.jobs,
      credentialStore: dependencies.credentialStore,
      ...(dependencies.host.promptCredential
        ? { promptCredential: (kind) => dependencies.host.promptCredential!(kind) }
        : {}),
      ...(dependencies.host.selectOutputDirectory
        ? {
            selectOutputDirectory: () => dependencies.host.selectOutputDirectory!(),
          }
        : {}),
    });
    await registerMonitoringHttp(app, {
      repository: repositories.monitoring,
      tasks: repositories.collection,
    });
    await registerTemplatesHttp(app, {
      collection: repositories.collection,
      platform: repositories.platform,
      credentialProtection: {
        credentialStore: dependencies.credentialStore,
        runtimeMode: dependencies.host.metadata.mode,
      },
      quality: repositories.monitoring,
    });
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
              const dataset = await repositories.datasets.getDatasetBySourceTask(binding.taskId!);
              if (!dataset) return [];
              const page = await repositories.datasets.listRecords(dataset.id, undefined, 500, {
                includeRemoved: false,
              });
              return normalizeTrendRecords(binding.key, page.items);
            }),
        );
        const signals = await preferencesService.listSignals(undefined, 10_000);
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
        const result = await dependencies.crawler.crawl({
          url: resolver.crawlUrl ?? input.url,
          plan: resolver.plan,
          requestSettings: {
            headers: {},
            cookies: [],
            timeoutMs: 20_000,
            retries: 0,
            retryBackoffMs: 1_000,
            concurrency: 1,
            delayMs: 1_500,
            maxRequests: 1,
            maxRuntimeMs: 30_000,
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
    await registerAnalyticsHttp(app, {
      catalog: analyticsCatalog,
      recipes: analysisRecipes,
      jobs: analysisJobs,
      platform: repositories.platform,
    });
    await registerCorpusHttp(app, {
      corpora,
      recipes: corpusRecipes,
      builds: corpusBuilds,
      platform: repositories.platform,
    });
    if (aiEnabled) {
      await registerAiAssistanceHttp(app, {
        service: aiAssistance,
        platform: repositories.platform,
        crawlerAssistant,
        providerSettings,
      });
    }
  };

  const gateway = await buildRuntimeGateway(
    {
      platform: repositories.platform,
      artifactStore: dependencies.artifactStore,
      jobs: dependencies.jobs,
      realtime,
      ...(aiEnabled
        ? {
            beforeJobsStart: () =>
              repositories.aiAssistance.failInterruptedTurns().then(() => undefined),
          }
        : {}),
      migrations: [
        { pluginId: 'platform', migrate: async () => undefined, close: async () => undefined },
        migration('datasets', repositories.datasets),
        migration('collection', repositories.collection),
        migration('outputs', repositories.outputs),
        migration('monitoring', repositories.monitoring),
        migration('preferences', repositories.preferences),
        migration('analytics', repositories.analytics),
        migration('corpus', repositories.corpus),
        ...(aiEnabled ? [migration('ai-assistance', repositories.aiAssistance)] : []),
        ...(dependencies.identity ? [migration('identity', dependencies.identity.repository)] : []),
      ],
      registerPluginHttp,
      metadata: dependencies.host.metadata,
      capabilities: dependencies.host.capabilities,
      openApiDocument: dependencies.openApiDocument,
      ...(dependencies.readiness ? { readiness: dependencies.readiness } : {}),
      effects: [
        new MonitoringEvaluationOutbox(repositories.platform, dependencies.jobs),
        new OutputEventNotificationOutbox(
          repositories.platform,
          repositories.outputs,
          dependencies.jobs,
        ),
        new OutputAttemptReplay(repositories.outputs, dependencies.jobs),
        collectionScheduler,
        ...(aiEnabled
          ? [
              {
                start: () => providerSettings.initialize(),
                close: async () => undefined,
              },
              new AiConversationRetention(repositories.aiAssistance),
            ]
          : []),
        { start: () => undefined, close: () => inspections.closeAll() },
      ],
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
                  format: artifactFormat(artifact.filename),
                  filename: artifact.filename,
                  contentType: artifact.contentType,
                  size: artifact.size,
                  createdAt: artifact.createdAt,
                },
                { storageKey: artifact.storageKey },
              ),
          }
        : {}),
      async authenticateDataToken(token) {
        const tokenHash = createHash('sha256').update(token).digest('hex');
        const stored = await repositories.outputs.findApiToken(tokenHash);
        if (!stored || (stored.expiresAt && Date.parse(stored.expiresAt) <= Date.now())) {
          return {
            ok: false as const,
            status: 401 as const,
            code: 'UNAUTHORIZED',
            detail: 'Invalid or expired Data API token',
          };
        }
        const window = Math.floor(Date.now() / 60_000);
        const current = dataApiRateLimits.get(stored.id);
        const counter = current?.window === window ? current : { window, count: 0 };
        if (counter.count >= stored.rateLimitPerMinute) {
          return {
            ok: false as const,
            status: 429 as const,
            code: 'RATE_LIMITED',
            detail: 'Data API rate limit exceeded',
          };
        }
        counter.count += 1;
        dataApiRateLimits.set(stored.id, counter);
        return { ok: true as const, principal: { tokenId: stored.id, taskIds: stored.taskIds } };
      },
      ...(identity
        ? {
            workspaceAuthorization: {
              async authenticate(input: {
                sessionToken: string | undefined;
                csrfToken: string | undefined;
                mutation: boolean;
              }) {
                let principal: IdentityPrincipal;
                try {
                  principal = await identity.authenticate(input.sessionToken ?? '');
                } catch (error) {
                  if (error instanceof IdentityError && [401, 403].includes(error.status)) {
                    return {
                      ok: false as const,
                      status: error.status as 401 | 403,
                      code: error.code,
                      detail: error.message,
                    };
                  }
                  throw error;
                }
                const gatewayPrincipal = {
                  userId: principal.user.id,
                  email: principal.user.email,
                  role: principal.user.role,
                };
                if (input.mutation) {
                  try {
                    identity.verifyCsrf(principal, input.csrfToken);
                  } catch (error) {
                    if (error instanceof IdentityError && error.status === 403) {
                      return {
                        ok: false as const,
                        status: 403 as const,
                        code: error.code,
                        detail: error.message,
                        principal: gatewayPrincipal,
                      };
                    }
                    throw error;
                  }
                }
                return {
                  ok: true as const,
                  principal: gatewayPrincipal,
                  permissions: rolePermissions[principal.user.role],
                };
              },
              audit(input: {
                principal: Record<string, unknown>;
                operationId: string;
                resourceType: string;
                resourceId: string | null;
                result: 'succeeded' | 'failed' | 'denied';
                statusCode: number;
                traceId: string;
                network: string;
              }) {
                const actorUserId = input.principal.userId;
                if (typeof actorUserId !== 'string' || !actorUserId) {
                  throw new Error('Authenticated workspace principal has no user ID');
                }
                return identity.recordOperation({
                  actorUserId,
                  operationId: input.operationId,
                  resourceType: input.resourceType,
                  resourceId: input.resourceId,
                  result: input.result,
                  statusCode: input.statusCode,
                  traceId: input.traceId,
                  network: input.network,
                });
              },
            },
          }
        : {}),
    },
    options,
  );
  return {
    ...gateway,
    setAnalyticsWorker(nextWorker, status) {
      worker.set(nextWorker);
      gateway.setAnalyticsWorkerStatus(status);
    },
  };
}

function artifactFormat(filename: string): 'csv' | 'json' | 'xlsx' {
  if (filename.toLowerCase().endsWith('.csv')) return 'csv';
  if (filename.toLowerCase().endsWith('.xlsx')) return 'xlsx';
  return 'json';
}

function migration(
  pluginId: string,
  repository: { migrate(): Promise<void>; close(): Promise<void> },
) {
  return {
    pluginId,
    migrate: () => repository.migrate(),
    close: () => repository.close(),
  };
}
