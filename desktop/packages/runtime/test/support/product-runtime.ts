import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AnalyticsWorkerClient, AnalyticsWorkerSupervisor } from '@zhiyun/analytics-worker-client';
import { createAiProvider } from '@zhiyun/ai-runtime';
import type { AiProvider } from '@zhiyun/contracts';
import { LocalArtifactStore } from '@zhiyun/artifact-store';
import { CrawlerRuntime } from '@zhiyun/crawler-runtime';
import { AesCredentialStore } from '@zhiyun/platform';
import { JobHandlerRegistry } from '@zhiyun/platform-core';
import { SqliteAnalysisRepository } from '@zhiyun/plugin-analytics';
import { SqliteAiConversationRepository } from '@zhiyun/plugin-ai-assistance';
import { SqliteCollectionRepository } from '@zhiyun/plugin-collection';
import { SqliteCorpusRepository } from '@zhiyun/plugin-corpus';
import { SqliteDatasetRepository } from '@zhiyun/plugin-datasets';
import { SqliteMonitoringRepository } from '@zhiyun/plugin-monitoring';
import { SqliteOutputRepository } from '@zhiyun/plugin-outputs';
import { SqlitePreferencesRepository } from '@zhiyun/plugin-preferences';
import { SqliteRecruitmentRepository } from '@zhiyun/plugin-recruitment';
import { resolveProductGraph } from '@zhiyun/product-profiles';
import { LocalPlatformJobQueue } from '@zhiyun/queue-local-v1';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import { buildLevel2Runtime, openApiDocument, type Level2Runtime } from '../../src/index.js';

// Exercise the local composition directly, without a separately deployed API or browser app.
export async function createProductRuntimeFixture(options: { ai?: AiProvider } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'zhiyun-product-api-test-'));
  const path = join(directory, 'zhiyun.sqlite3');
  const workerRoot = resolve(import.meta.dirname, '../../../../analytics-worker');
  const worker = new AnalyticsWorkerSupervisor({
    command: join(
      workerRoot,
      '.venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
    ),
    args: ['-m', 'zhiyun_analytics_worker'],
    workspaceRoot: join(directory, 'job-workspaces'),
  });
  let runtime: Level2Runtime | undefined;
  const close = async () => {
    try {
      await runtime?.close();
    } finally {
      await worker.stop();
      await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    const connection = await worker.start();
    const platform = await openSqlitePlatformRepository({
      dataDirectory: directory,
      filePath: path,
      graphRevision: resolveProductGraph('test').revision,
    });
    const handlers = new JobHandlerRegistry();
    const credentials = new AesCredentialStore(join(directory, 'credentials'), undefined, false);
    const repositories = {
      platform,
      datasets: new SqliteDatasetRepository(path),
      collection: new SqliteCollectionRepository(path),
      outputs: new SqliteOutputRepository(path),
      monitoring: new SqliteMonitoringRepository(path),
      preferences: new SqlitePreferencesRepository(path),
      recruitment: new SqliteRecruitmentRepository(path),
      analytics: new SqliteAnalysisRepository(path),
      corpus: new SqliteCorpusRepository(path),
      aiAssistance: new SqliteAiConversationRepository(path),
    };
    const jobs = new LocalPlatformJobQueue(platform, handlers);
    runtime = await buildLevel2Runtime(
      {
        repositories,
        handlers,
        jobs,
        crawler: new CrawlerRuntime(),
        ai: options.ai ?? createAiProvider(),
        credentialStore: credentials,
        artifactStore: new LocalArtifactStore(directory),
        analyticsWorker: new AnalyticsWorkerClient(connection),
        openApiDocument: openApiDocument('test'),
        host: {
          metadata: {
            runtimeId: crypto.randomUUID(),
            generation: 1,
            apiVersion: 'v2',
            mode: 'desktop',
            productVersion: '1.0.0',
            analyticsWorkerStatus: 'ready',
            startedAt: new Date().toISOString(),
          },
          capabilities: {
            platform: 'darwin',
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
        sessionNonce: 'product-integration-session',
        profileId: 'test',
        allowedOrigins: ['app://zhiyun'],
        logger: false,
      },
    );
    return { app: runtime.app, close, credentials, repositories, jobs, directory };
  } catch (error) {
    await close();
    throw error;
  }
}
