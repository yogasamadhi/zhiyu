import type { Context } from '@deepseek-ai/cordis';
import { join } from 'node:path';
import { createAiProvider, HostedAiProvider } from '@zhiyun/ai-runtime';
import {
  AnalyticsWorkerClient,
  type AnalyticsWorkerPrivateBootstrap,
} from '@zhiyun/analytics-worker-client';
import { LocalArtifactStore } from '@zhiyun/artifact-store';
import { CrawlerRuntime } from '@zhiyun/crawler-runtime';
import type { HostCapabilities, SchedulingEnvironment } from '@zhiyun/contracts';
import { HostCredentialStore } from '@zhiyun/platform';
import { JobHandlerRegistry } from '@zhiyun/platform-core';
import { SqliteAiConversationRepository } from '@zhiyun/plugin-ai-assistance';
import { SqliteAnalysisRepository } from '@zhiyun/plugin-analytics';
import { SqliteCollectionRepository } from '@zhiyun/plugin-collection';
import { SqliteCorpusRepository } from '@zhiyun/plugin-corpus';
import { SqliteIdentityRepository, type IdentityServiceOptions } from '@zhiyun/plugin-identity';
import { SqliteDatasetRepository } from '@zhiyun/plugin-datasets';
import { SqliteMonitoringRepository } from '@zhiyun/plugin-monitoring';
import { SqliteOutputRepository } from '@zhiyun/plugin-outputs';
import { SqlitePreferencesRepository } from '@zhiyun/plugin-preferences';
import { SqliteRecruitmentRepository } from '@zhiyun/plugin-recruitment';
import { LocalPlatformJobQueue } from '@zhiyun/queue-local-v1';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import type { Level2RuntimeDependencies } from '@zhiyun/runtime-contracts';
import { buildRuntimeFromResources, type Level2RuntimeOptions } from './level2.js';

export interface DesktopRuntimeInputs {
  dataDirectory: string;
  hostBaseUrl: string;
  hostToken: string;
  host: HostCapabilities;
  schedulingEnvironment: SchedulingEnvironment;
  analyticsWorker?: AnalyticsWorkerPrivateBootstrap;
  ai?: { baseUrl?: string; model?: string; apiKeyRef?: string };
  hostedAi: {
    request: ConstructorParameters<typeof HostedAiProvider>[0];
    configuration: ConstructorParameters<typeof HostedAiProvider>[1];
    enabled(): boolean;
  };
  openApiDocument: unknown;
  identity?: { options: IdentityServiceOptions; secureCookies?: boolean };
}

/** Internal infrastructure plugin: production adapters are created inside Cordis. */
export function buildDesktopRuntime(inputs: DesktopRuntimeInputs, options: Level2RuntimeOptions) {
  return buildRuntimeFromResources(
    async (ctx: Context, close, graph): Promise<Level2RuntimeDependencies> => {
      function own<T extends { close(): Promise<void> }>(resource: T): T {
        ctx.effect(() => () => close(resource), 'desktop-resource');
        return resource;
      }
      const databasePath = join(inputs.dataDirectory, 'zhiyun.sqlite3');
      const platform = own(
        await openSqlitePlatformRepository({
          dataDirectory: inputs.dataDirectory,
          filePath: databasePath,
          graphRevision: graph.revision,
        }),
      );
      const repositories = {
        platform,
        datasets: own(new SqliteDatasetRepository(databasePath)),
        collection: own(new SqliteCollectionRepository(databasePath)),
        outputs: own(new SqliteOutputRepository(databasePath)),
        monitoring: own(new SqliteMonitoringRepository(databasePath)),
        preferences: own(new SqlitePreferencesRepository(databasePath)),
        recruitment: own(new SqliteRecruitmentRepository(databasePath)),
        analytics: own(new SqliteAnalysisRepository(databasePath)),
        corpus: own(new SqliteCorpusRepository(databasePath)),
        aiAssistance: own(new SqliteAiConversationRepository(databasePath)),
      };
      const handlers = new JobHandlerRegistry();
      const jobs = own(
        new LocalPlatformJobQueue(platform, handlers, {
          capacities: { 'browser-heavy': 1, 'python-heavy': 1, io: 1, delivery: 1 },
        }),
      );
      const credentialStore = new HostCredentialStore(inputs.hostBaseUrl, inputs.hostToken);
      const hosted = new HostedAiProvider(inputs.hostedAi.request, inputs.hostedAi.configuration);
      const ai = createAiProvider({
        ...(inputs.ai?.baseUrl && inputs.ai.model && inputs.ai.apiKeyRef
          ? {
              baseUrl: inputs.ai.baseUrl,
              model: inputs.ai.model,
              apiKey: () => credentialStore.resolve<string>(inputs.ai!.apiKeyRef!),
            }
          : {}),
        onUsage: async (usage) => {
          await platform
            .appendEvent({
              type: 'ai.request.completed',
              producerPluginId: 'ai-assistance',
              aggregateType: usage.taskId ? 'task' : 'runtime',
              aggregateId: usage.taskId ?? inputs.host.metadata.runtimeId,
              payload: { ...usage },
            })
            .catch(() => undefined);
        },
      });
      let worker: AnalyticsWorkerClient | undefined;
      if (inputs.analyticsWorker) {
        try {
          worker = new AnalyticsWorkerClient(inputs.analyticsWorker);
          await worker.health();
          inputs.host.metadata.analyticsWorkerStatus = 'ready';
        } catch {
          worker = undefined;
          inputs.host.metadata.analyticsWorkerStatus = 'degraded';
        }
      }
      return {
        repositories,
        handlers,
        jobs,
        crawler: new CrawlerRuntime(),
        ai,
        aiOverride: () => (inputs.hostedAi.enabled() ? hosted : undefined),
        credentialStore,
        artifactStore: own(new LocalArtifactStore(inputs.dataDirectory)),
        ...(inputs.identity
          ? {
              identity: {
                repository: own(new SqliteIdentityRepository(databasePath)),
                options: inputs.identity.options,
                ...(inputs.identity.secureCookies === undefined
                  ? {}
                  : { secureCookies: inputs.identity.secureCookies }),
              },
            }
          : {}),
        ...(worker ? { analyticsWorker: worker } : {}),
        openApiDocument: inputs.openApiDocument,
        schedulingEnvironment: inputs.schedulingEnvironment,
        host: inputs.host,
      };
    },
    options,
  );
}
