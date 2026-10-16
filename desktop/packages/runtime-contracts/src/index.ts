import type { Context } from '@deepseek-ai/cordis';
import type { AnalyticsWorkerClient } from '@zhiyun/analytics-worker-client';
import type {
  AiProvider,
  CrawlerService,
  CredentialStore,
  HostCapabilities,
  SchedulingEnvironment,
} from '@zhiyun/contracts';
import type {
  ArtifactStore,
  JobHandlerRegistry,
  PlatformJobQueue,
  PlatformRepository,
} from '@zhiyun/platform-core';
import type { AiConversationRepository } from '@zhiyun/plugin-ai-assistance/types';
import type { AnalysisRepository } from '@zhiyun/plugin-analytics/types';
import type { CollectionRepository } from '@zhiyun/plugin-collection/types';
import type { CorpusRepository } from '@zhiyun/plugin-corpus/types';
import type { DatasetRepository } from '@zhiyun/plugin-datasets/types';
import type { IdentityRepository, IdentityServiceOptions } from '@zhiyun/plugin-identity/types';
import type { MonitoringRepository } from '@zhiyun/plugin-monitoring/types';
import type { OutputRepository } from '@zhiyun/plugin-outputs/types';
import type { PreferencesRepository } from '@zhiyun/plugin-preferences/types';
import type { RecruitmentRepository } from '@zhiyun/plugin-recruitment/types';
import type { ResolvedGraph } from '@zhiyun/plugin-runtime';
import type { RuntimeGatewayOptions, RuntimeReadinessProbe } from '@zhiyun/runtime-gateway';
import type { FastifyInstance } from 'fastify';

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
  recruitment: RecruitmentRepository;
}
export interface Level2RuntimeDependencies {
  repositories: Level2RuntimeRepositories;
  artifactStore: ArtifactStore;
  jobs: PlatformJobQueue;
  handlers: JobHandlerRegistry;
  crawler: CrawlerService;
  ai: AiProvider;
  aiOverride?: () => AiProvider | undefined;
  credentialStore: CredentialStore;
  analyticsWorker?: AnalyticsWorkerClient;
  host: HostCapabilities;
  schedulingEnvironment?: SchedulingEnvironment;
  openApiDocument: unknown;
  readiness?(): Promise<RuntimeReadinessProbe>;
  identity?: {
    repository: IdentityRepository;
    options: IdentityServiceOptions;
    secureCookies?: boolean;
  };
}
export interface RuntimeHost {
  dependencies: Level2RuntimeDependencies;
  options: RuntimeGatewayOptions;
  graph: ResolvedGraph;
  routes: RuntimeRoutes;
  closeJobs(): Promise<void>;
  closeRepository(repository: { close(): Promise<void> }): Promise<void>;
}
export class RuntimeRoutes {
  private registrations = new Map<string, (app: FastifyInstance) => Promise<void>>();
  private installed = false;
  register(owner: string, install: (app: FastifyInstance) => Promise<void>): () => void {
    if (this.installed || this.registrations.has(owner))
      throw new Error('Duplicate or late HTTP registration: ' + owner);
    this.registrations.set(owner, install);
    return () => {
      this.registrations.delete(owner);
    };
  }
  async install(app: FastifyInstance): Promise<void> {
    this.installed = true;
    for (const register of this.registrations.values()) await register(app);
  }
}
export function ownRuntimeEffect(
  ctx: Context,
  effect: { start(): void | Promise<void>; close(): Promise<void> },
  label: string,
): void {
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= Promise.resolve().then(() => effect.close()));
  ctx.effect(() => close, label);
  ctx.on('runtime/stopping', close);
  ctx.on('runtime/start', async () => {
    await ctx.effect(async () => {
      await effect.start();
      return () => {};
    }, 'start:' + label);
  });
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    runtimeHost: RuntimeHost;
    jobs: PlatformJobQueue;
    jobHandlers: JobHandlerRegistry;
    artifacts: ArtifactStore;
    credentials: CredentialStore;
    hostCapabilities: HostCapabilities;
    crawlerProvider: CrawlerService;
    aiProvider: AiProvider;
  }
  interface Events {
    /** @mode parallel */ 'runtime/start'(): Promise<void>;
    /** @mode parallel */ 'runtime/before-jobs'(): Promise<void>;
    /** @mode parallel */ 'runtime/stopping'(): Promise<void>;
  }
}

export type { RuntimeServices as PlatformRuntimeServices } from '@zhiyun/plugin-platform/types';
