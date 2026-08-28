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
import { AiAssistanceService, registerAiAssistanceHttp } from '@zhiyun/plugin-ai-assistance';
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
  OutputsService,
  createOutputDeliveryJobHandler,
  enqueueOutputDelivery,
  registerOutputsHttp,
  type OutputRepository,
} from '@zhiyun/plugin-outputs';
import {
  PreferencesHttpError,
  PreferencesService,
  registerPreferencesHttp,
  type PreferencesRepository,
} from '@zhiyun/plugin-preferences';
import {
  buildRuntimeGateway,
  type RuntimeGateway,
  type RuntimeGatewayOptions,
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

export async function buildLevel2Runtime(
  dependencies: Level2RuntimeDependencies,
  options: Level2RuntimeOptions,
): Promise<Level2Runtime> {
  const repositories = dependencies.repositories;
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
  const aiAssistance = new AiAssistanceService(
    {
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
    },
    dependencies.ai,
    dependencies.crawler,
  );

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
        const existing = new Map(
          (await repositories.outputs.listDeliveryAttempts(run.id)).map((attempt) => [
            attempt.destinationId,
            attempt,
          ]),
        );
        for (const destinationId of await repositories.outputs.listTaskBindings(task.id)) {
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
    }),
  });

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
    const binding = await repositories.preferences.getTrendSourceBinding(key);
    if (!binding?.taskId) return { key, status: 'skipped', reason: 'not-installed' };
    if (!binding.enabled) return { key, status: 'skipped', reason: 'disabled' };
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
          url: input.url,
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
    await registerAiAssistanceHttp(app, {
      service: aiAssistance,
      platform: repositories.platform,
    });
  };

  const gateway = await buildRuntimeGateway(
    {
      platform: repositories.platform,
      artifactStore: dependencies.artifactStore,
      jobs: dependencies.jobs,
      migrations: [
        { pluginId: 'platform', migrate: async () => undefined, close: async () => undefined },
        repositories.datasets,
        repositories.collection,
        repositories.outputs,
        repositories.preferences,
        repositories.analytics,
        repositories.corpus,
      ].map((repository, index) => ({
        pluginId:
          index === 0
            ? 'platform'
            : ['datasets', 'collection', 'outputs', 'preferences', 'analytics', 'corpus'][
                index - 1
              ]!,
        migrate: () => repository.migrate(),
        close: () => repository.close(),
      })),
      registerPluginHttp,
      metadata: dependencies.host.metadata,
      capabilities: dependencies.host.capabilities,
      openApiDocument: dependencies.openApiDocument,
      effects: [
        collectionScheduler,
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
