import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { AnalyticsWorkerClient, AnalyticsWorkerSupervisor } from '@zhiyun/analytics-worker-client';
import { createAiProvider } from '@zhiyun/ai-runtime';
import { LocalArtifactStore } from '@zhiyun/artifact-store';
import { getConfig } from '@zhiyun/config';
import { CrawlerRuntime } from '@zhiyun/crawler-runtime';
import { AesCredentialStore } from '@zhiyun/platform';
import { JobHandlerRegistry } from '@zhiyun/platform-core';
import { PostgresAnalysisRepository } from '@zhiyun/plugin-analytics';
import { PostgresAiConversationRepository } from '@zhiyun/plugin-ai-assistance';
import { PostgresCollectionRepository } from '@zhiyun/plugin-collection';
import { PostgresCorpusRepository } from '@zhiyun/plugin-corpus';
import { PostgresDatasetRepository } from '@zhiyun/plugin-datasets';
import { PostgresIdentityRepository } from '@zhiyun/plugin-identity';
import { PostgresOutputRepository } from '@zhiyun/plugin-outputs';
import { PostgresMonitoringRepository } from '@zhiyun/plugin-monitoring';
import { PostgresPreferencesRepository } from '@zhiyun/plugin-preferences';
import { PostgresRecruitmentRepository } from '@zhiyun/plugin-recruitment';
import { resolveProductGraph } from '@zhiyun/product-profiles';
import { RedisPlatformJobQueue, resetLegacyRedis } from '@zhiyun/queue-redis-v1';
import { buildLevel2Runtime, openApiDocument, type Level2Runtime } from '@zhiyun/runtime';
import { openPostgresPlatformRepository } from '@zhiyun/storage-postgres-v1';
import { registerStaticWeb } from './static-web.js';

function analyticsWorkerLaunch(): { command: string; args: string[] } {
  if (process.env.ZHIYUN_ANALYTICS_WORKER_PATH) {
    return { command: process.env.ZHIYUN_ANALYTICS_WORKER_PATH, args: [] };
  }
  const bundled = join(
    dirname(process.execPath),
    'analytics-worker',
    'linux-x64',
    'analytics-worker',
    'analytics-worker',
  );
  if (process.platform === 'linux' && process.arch === 'x64' && existsSync(bundled)) {
    return { command: bundled, args: [] };
  }
  const workspaceRoot = resolve(import.meta.dirname, '../../..');
  const python =
    process.platform === 'win32'
      ? join(workspaceRoot, 'services', 'analytics-worker', '.venv', 'Scripts', 'python.exe')
      : join(workspaceRoot, 'services', 'analytics-worker', '.venv', 'bin', 'python');
  return { command: python, args: ['-m', 'zhiyun_analytics_worker'] };
}

export async function buildApp() {
  const config = getConfig();
  const dataDirectory = resolve(config.ZHIYUN_DATA_DIR);
  const outputDirectory = resolve(config.ZHIYUN_OUTPUT_ROOT ?? join(dataDirectory, 'outputs'));
  process.env.ZHIYUN_OUTPUT_ROOT = outputDirectory;
  const runtimeHolder: { current?: Level2Runtime } = {};
  const workerSupervisor = new AnalyticsWorkerSupervisor({
    ...analyticsWorkerLaunch(),
    workspaceRoot: join(dataDirectory, 'job-workspaces'),
    onStateChange(state) {
      const runtime = runtimeHolder.current;
      if (!runtime) return;
      if (state.status === 'ready') {
        const connection = workerSupervisor.connection();
        runtime.setAnalyticsWorker(
          connection ? new AnalyticsWorkerClient(connection) : undefined,
          'ready',
        );
      }
      if (state.status === 'degraded') runtime.setAnalyticsWorker(undefined, 'degraded');
      if (state.status === 'stopped') runtime.setAnalyticsWorker(undefined, 'unavailable');
    },
    onLog(stream, message) {
      const output = stream === 'stdout' ? process.stdout : process.stderr;
      output.write(`[analytics-worker] ${message}`);
    },
  });
  const workerConnection = await workerSupervisor.start().catch((error: unknown) => {
    if (config.NODE_ENV !== 'test') {
      console.warn(
        '[api] analytics worker unavailable; collection Runtime will continue',
        error instanceof Error ? error.message : String(error),
      );
    }
    return undefined;
  });
  const profileId = config.NODE_ENV === 'test' ? 'test' : 'headless-server';
  const graph = resolveProductGraph(profileId);
  const identityEnabled = graph.plugins.some(({ descriptor }) => descriptor.id === 'identity');
  const bootstrapToken =
    config.ZHIYUN_BOOTSTRAP_TOKEN ??
    config.ZHIYUN_ADMIN_TOKEN ??
    (config.NODE_ENV === 'production'
      ? undefined
      : 'headless-development-bootstrap-token-change-me');
  const identityIdentifierPepper = config.ZHIYUN_CREDENTIAL_KEY ?? bootstrapToken;
  if (identityEnabled && !identityIdentifierPepper) {
    throw new Error('Identity requires ZHIYUN_CREDENTIAL_KEY or a bootstrap token');
  }
  const identityRepository = identityEnabled
    ? new PostgresIdentityRepository(config.DATABASE_URL)
    : undefined;
  const platform = await openPostgresPlatformRepository({
    connectionString: config.DATABASE_URL,
    graphRevision: graph.revision,
  });
  await resetLegacyRedis(config.REDIS_URL);
  const repositories = {
    platform,
    datasets: new PostgresDatasetRepository(config.DATABASE_URL),
    collection: new PostgresCollectionRepository(config.DATABASE_URL),
    outputs: new PostgresOutputRepository(config.DATABASE_URL),
    monitoring: new PostgresMonitoringRepository(config.DATABASE_URL),
    preferences: new PostgresPreferencesRepository(config.DATABASE_URL),
    recruitment: new PostgresRecruitmentRepository(config.DATABASE_URL),
    analytics: new PostgresAnalysisRepository(config.DATABASE_URL),
    corpus: new PostgresCorpusRepository(config.DATABASE_URL),
    aiAssistance: new PostgresAiConversationRepository(config.DATABASE_URL),
  };
  const handlers = new JobHandlerRegistry();
  const jobs = new RedisPlatformJobQueue(platform, config.REDIS_URL, handlers, {
    capacities: { 'browser-heavy': 2, 'python-heavy': 1, io: 2, delivery: 2 },
  });
  const credentials = new AesCredentialStore(
    join(dataDirectory, 'credentials'),
    config.ZHIYUN_CREDENTIAL_KEY,
    config.NODE_ENV === 'production',
  );
  const apiKeyRef = config.AI_API_KEY
    ? await credentials.put('ai-api-key', config.AI_API_KEY)
    : undefined;
  const metadata = {
    runtimeId: crypto.randomUUID(),
    generation: 0,
    apiVersion: 'v2' as const,
    mode: 'headless' as const,
    productVersion: '1.0.0' as const,
    analyticsWorkerStatus: workerConnection ? ('ready' as const) : ('degraded' as const),
    startedAt: new Date().toISOString(),
  };
  const ai = createAiProvider({
    ...(config.AI_BASE_URL && config.AI_MODEL && apiKeyRef
      ? {
          baseUrl: config.AI_BASE_URL,
          model: config.AI_MODEL,
          apiKey: () => credentials.resolve<string>(apiKeyRef),
        }
      : {}),
    onUsage: async (usage) => {
      await platform
        .appendEvent({
          type: 'ai.request.completed',
          producerPluginId: 'ai-assistance',
          aggregateType: usage.taskId ? 'task' : 'runtime',
          aggregateId: usage.taskId ?? metadata.runtimeId,
          payload: { ...usage },
        })
        .catch(() => undefined);
    },
  });
  const runtime = await buildLevel2Runtime(
    {
      repositories,
      handlers,
      jobs,
      crawler: new CrawlerRuntime(),
      ai,
      credentialStore: credentials,
      artifactStore: new LocalArtifactStore(dataDirectory),
      ...(workerConnection ? { analyticsWorker: new AnalyticsWorkerClient(workerConnection) } : {}),
      openApiDocument: openApiDocument(profileId),
      readiness: () => jobs.readiness(),
      host: {
        metadata,
        capabilities: {
          platform: 'headless',
          browser: true,
          cron: true,
          credentials: true,
          artifactSaveDialog: false,
          notifications: false,
          tray: false,
        },
      },
      ...(identityRepository
        ? {
            identity: {
              repository: identityRepository,
              options: {
                ...(bootstrapToken ? { bootstrapToken } : {}),
                identifierPepper: identityIdentifierPepper!,
                ...(config.ZHIYUN_ADMIN_TOKEN
                  ? { legacyAdminToken: config.ZHIYUN_ADMIN_TOKEN }
                  : {}),
              },
              secureCookies:
                config.NODE_ENV === 'production' ||
                Boolean(config.ZHIYUN_PUBLIC_URL?.startsWith('https://')),
            },
          }
        : {}),
    },
    {
      sessionNonce: config.ZHIYUN_SESSION_NONCE,
      reusableSessionNonce: true,
      ...(!identityEnabled && config.ZHIYUN_ADMIN_TOKEN
        ? { adminToken: config.ZHIYUN_ADMIN_TOKEN }
        : {}),
      trustProxy: config.ZHIYUN_TRUST_PROXY,
      allowedOrigins: [
        `http://localhost:${config.WEB_PORT}`,
        `http://127.0.0.1:${config.WEB_PORT}`,
        `http://localhost:${config.API_PORT}`,
        `http://127.0.0.1:${config.API_PORT}`,
        ...(config.ZHIYUN_PUBLIC_URL ? [new URL(config.ZHIYUN_PUBLIC_URL).origin] : []),
        ...(config.ZHIYUN_ALLOWED_ORIGINS?.split(',')
          .map((origin) => origin.trim())
          .filter(Boolean) ?? []),
      ],
      logger: config.NODE_ENV === 'test' ? false : { level: 'info' },
      profileId,
    },
  );
  runtimeHolder.current = runtime;
  runtime.app.addHook('onClose', async () => workerSupervisor.stop());
  await registerStaticWeb(runtime.app);
  return runtime.app;
}
