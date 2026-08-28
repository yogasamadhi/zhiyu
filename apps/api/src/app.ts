import { join } from 'node:path';
import { createAiProvider } from '@zhiyun/ai-runtime';
import { getConfig } from '@zhiyun/config';
import { CrawlerRuntime } from '@zhiyun/crawler-runtime';
import { AesCredentialStore, FileArtifactStore } from '@zhiyun/platform';
import { buildRuntime } from '@zhiyun/runtime';
import { TaskQueue } from '@zhiyun/scheduler';
import { PostgresRepository } from '@zhiyun/storage';

export async function buildApp() {
  const config = getConfig();
  const dataDirectory = join(process.cwd(), '.data', 'headless');
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
    analyticsWorkerStatus: 'unavailable' as const,
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
  return runtime.app;
}
