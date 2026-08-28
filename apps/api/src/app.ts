import { join, resolve } from 'node:path';
import { AnalyticsWorkerSupervisor } from '@zhiyun/analytics-worker-client';
import { createAiProvider } from '@zhiyun/ai-runtime';
import { getConfig } from '@zhiyun/config';
import { CrawlerRuntime } from '@zhiyun/crawler-runtime';
import { AesCredentialStore, FileArtifactStore } from '@zhiyun/platform';
import { buildRuntime, type ZhiYunRuntime } from '@zhiyun/runtime';
import { TaskQueue } from '@zhiyun/scheduler';
import { PostgresRepository } from '@zhiyun/storage';

function analyticsWorkerLaunch(): { command: string; args: string[] } {
  if (process.env.ZHIYUN_ANALYTICS_WORKER_PATH) {
    return { command: process.env.ZHIYUN_ANALYTICS_WORKER_PATH, args: [] };
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
  const dataDirectory = join(process.cwd(), '.data', 'headless');
  const runtimeHolder: { current?: ZhiYunRuntime } = {};
  const workerSupervisor = new AnalyticsWorkerSupervisor({
    ...analyticsWorkerLaunch(),
    workspaceRoot: join(dataDirectory, 'job-workspaces', 'analytics-worker'),
    onStateChange(state) {
      const runtime = runtimeHolder.current;
      if (!runtime) return;
      if (state.status === 'ready') runtime.setAnalyticsWorkerStatus('ready');
      if (state.status === 'degraded') runtime.setAnalyticsWorkerStatus('degraded');
      if (state.status === 'stopped') runtime.setAnalyticsWorkerStatus('unavailable');
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
  const repository = new PostgresRepository();
  const queue = new TaskQueue(config.REDIS_URL);
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
      await repository
        .appendEvent({
          type: 'ai.request.completed',
          aggregateType: usage.taskId ? 'task' : 'runtime',
          aggregateId: usage.taskId ?? metadata.runtimeId,
          payload: { ...usage },
        })
        .catch(() => undefined);
    },
  });
  const runtime = await buildRuntime(
    {
      repository,
      queue,
      scheduler: queue,
      crawler: new CrawlerRuntime(),
      ai,
      credentialStore: credentials,
      artifactStore: new FileArtifactStore(join(dataDirectory, 'artifacts')),
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
    },
    {
      sessionNonce: config.ZHIYUN_SESSION_NONCE,
      reusableSessionNonce: true,
      ...(config.ZHIYUN_ADMIN_TOKEN ? { adminToken: config.ZHIYUN_ADMIN_TOKEN } : {}),
      trustProxy: config.ZHIYUN_TRUST_PROXY,
      allowedOrigins: [
        `http://localhost:${config.WEB_PORT}`,
        `http://127.0.0.1:${config.WEB_PORT}`,
        ...(config.ZHIYUN_ALLOWED_ORIGINS?.split(',')
          .map((origin) => origin.trim())
          .filter(Boolean) ?? []),
      ],
      logger: config.NODE_ENV === 'test' ? false : { level: 'info' },
      profileId: config.NODE_ENV === 'test' ? 'test' : 'headless-server',
    },
  );
  runtimeHolder.current = runtime;
  runtime.app.addHook('onClose', async () => workerSupervisor.stop());
  return runtime.app;
}
