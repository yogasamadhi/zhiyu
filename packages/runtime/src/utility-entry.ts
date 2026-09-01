import { join } from 'node:path';
import { createAiProvider } from '@zhiyun/ai-runtime';
import {
  AnalyticsWorkerClient,
  type AnalyticsWorkerPrivateBootstrap,
} from '@zhiyun/analytics-worker-client';
import { LocalArtifactStore } from '@zhiyun/artifact-store';
import { CrawlerRuntime } from '@zhiyun/crawler-runtime';
import { HostCredentialStore } from '@zhiyun/platform';
import { JobHandlerRegistry } from '@zhiyun/platform-core';
import { SqliteAnalysisRepository } from '@zhiyun/plugin-analytics';
import { SqliteAiConversationRepository } from '@zhiyun/plugin-ai-assistance';
import { SqliteCollectionRepository } from '@zhiyun/plugin-collection';
import { SqliteCorpusRepository } from '@zhiyun/plugin-corpus';
import { SqliteDatasetRepository } from '@zhiyun/plugin-datasets';
import { SqliteOutputRepository } from '@zhiyun/plugin-outputs';
import { SqliteMonitoringRepository } from '@zhiyun/plugin-monitoring';
import { SqlitePreferencesRepository } from '@zhiyun/plugin-preferences';
import { SqliteRecruitmentRepository } from '@zhiyun/plugin-recruitment';
import { resolveProductGraph } from '@zhiyun/product-profiles';
import { LocalPlatformJobQueue } from '@zhiyun/queue-local-v1';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import type { ArtifactDescriptor, HostCapabilities, RuntimeCapabilities } from '@zhiyun/contracts';
import { buildLevel2Runtime, openApiDocument, type Level2Runtime } from './index.js';

interface BootstrapMessage {
  type: 'bootstrap';
  dataDirectory: string;
  hostBaseUrl: string;
  hostToken: string;
  sessionNonce: string;
  generation: number;
  browserResources?: string;
  rendererOrigin?: string;
  analyticsWorker?: AnalyticsWorkerPrivateBootstrap;
  analyticsWorkerStatus?: 'ready' | 'degraded' | 'unavailable';
  ai?: { baseUrl?: string; model?: string; apiKeyRef?: string };
}

interface ParentPortLike {
  on(
    event: 'message',
    listener: (event: {
      data:
        | BootstrapMessage
        | { type: 'shutdown' }
        | {
            type: 'analytics-worker-changed';
            worker?: AnalyticsWorkerPrivateBootstrap;
            status: 'ready' | 'degraded' | 'unavailable';
          }
        | { type: 'issue-session-nonce'; nonce: string; requestId: string };
    }) => void,
  ): void;
  postMessage(message: unknown): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
if (!parentPort)
  throw new Error('ZhiYun desktop Runtime must be started as an Electron utilityProcess');
const desktopParentPort = parentPort;

let runtime: Level2Runtime | undefined;
let analyticsWorkerClient: AnalyticsWorkerClient | undefined;

async function hostRequest<T>(message: BootstrapMessage, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${message.hostBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${message.hostToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Host capability request failed: HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function bootstrap(message: BootstrapMessage): Promise<void> {
  if (runtime) throw new Error('Runtime is already bootstrapped');
  if (message.browserResources) process.env.PLAYWRIGHT_BROWSERS_PATH = message.browserResources;
  const databasePath = join(message.dataDirectory, 'zhiyun.sqlite3');
  const graph = resolveProductGraph('desktop-studio');
  const platform = await openSqlitePlatformRepository({
    dataDirectory: message.dataDirectory,
    filePath: databasePath,
    graphRevision: graph.revision,
  });
  const repositories = {
    platform,
    datasets: new SqliteDatasetRepository(databasePath),
    collection: new SqliteCollectionRepository(databasePath),
    outputs: new SqliteOutputRepository(databasePath),
    monitoring: new SqliteMonitoringRepository(databasePath),
    preferences: new SqlitePreferencesRepository(databasePath),
    recruitment: new SqliteRecruitmentRepository(databasePath),
    analytics: new SqliteAnalysisRepository(databasePath),
    corpus: new SqliteCorpusRepository(databasePath),
    aiAssistance: new SqliteAiConversationRepository(databasePath),
  };
  const handlers = new JobHandlerRegistry();
  const jobs = new LocalPlatformJobQueue(platform, handlers, {
    capacities: { 'browser-heavy': 1, 'python-heavy': 1, io: 1, delivery: 1 },
  });
  const credentialStore = new HostCredentialStore(message.hostBaseUrl, message.hostToken);
  let analyticsWorkerStatus = message.analyticsWorkerStatus ?? 'unavailable';
  if (message.analyticsWorker) {
    try {
      analyticsWorkerClient = new AnalyticsWorkerClient(message.analyticsWorker);
      await analyticsWorkerClient.health();
      analyticsWorkerStatus = 'ready';
    } catch {
      analyticsWorkerClient = undefined;
      analyticsWorkerStatus = 'degraded';
    }
  }
  const metadata: HostCapabilities['metadata'] = {
    runtimeId: crypto.randomUUID(),
    generation: message.generation,
    apiVersion: 'v2',
    mode: 'desktop',
    productVersion: '1.0.0',
    analyticsWorkerStatus,
    startedAt: new Date().toISOString(),
  };
  const capabilities: RuntimeCapabilities = {
    platform: process.platform === 'darwin' ? 'darwin' : 'win32',
    browser: true,
    cron: true,
    credentials: true,
    artifactSaveDialog: true,
    notifications: true,
    tray: true,
  };
  const ai = createAiProvider({
    ...(message.ai?.baseUrl && message.ai.model && message.ai.apiKeyRef
      ? {
          baseUrl: message.ai.baseUrl,
          model: message.ai.model,
          apiKey: () => credentialStore.resolve<string>(message.ai!.apiKeyRef!),
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
  runtime = await buildLevel2Runtime(
    {
      repositories,
      handlers,
      jobs,
      crawler: new CrawlerRuntime(),
      ai,
      credentialStore,
      artifactStore: new LocalArtifactStore(message.dataDirectory),
      ...(analyticsWorkerClient ? { analyticsWorker: analyticsWorkerClient } : {}),
      openApiDocument: openApiDocument('desktop-studio'),
      host: {
        metadata,
        capabilities,
        async saveArtifact(
          artifact: ArtifactDescriptor,
          source: { storageKey: string } | { data: Buffer },
        ) {
          return hostRequest<{ saved: boolean }>(message, '/artifacts/save', {
            artifact,
            ...('storageKey' in source
              ? { storageKey: source.storageKey }
              : { data: source.data.toString('base64') }),
          });
        },
        async notify(title: string, body: string) {
          await hostRequest(message, '/notifications/show', { title, body });
        },
        async createLoginSession(url: string) {
          return hostRequest<{ reference: string } | { canceled: true }>(
            message,
            '/credentials/login',
            { url },
          );
        },
        async promptCredential(kind) {
          return hostRequest<{ reference: string } | { canceled: true }>(
            message,
            '/credentials/prompt',
            { kind },
          );
        },
        async selectOutputDirectory() {
          return hostRequest<{ reference: string } | { canceled: true }>(
            message,
            '/outputs/select-directory',
            {},
          );
        },
        async saveBackup(filename: string, data: Buffer) {
          return hostRequest<{ saved: boolean }>(message, '/artifacts/save', {
            artifact: { filename },
            data: data.toString('base64'),
          });
        },
        async selectRestoreBackup() {
          const result = await hostRequest<{ canceled: true } | { data: string }>(
            message,
            '/database/select-restore',
            {},
          );
          return 'canceled' in result ? result : { data: Buffer.from(result.data, 'base64') };
        },
        async restartRuntime() {
          await hostRequest(message, '/runtime/restart', {});
        },
      },
    },
    {
      sessionNonce: message.sessionNonce,
      // Chromium serializes the opaque custom-protocol origin as `null` for CORS preflights.
      // Session nonces and bearer authentication remain the authority boundary.
      allowedOrigins: [
        'app://zhiyun',
        'null',
        ...(message.rendererOrigin ? [message.rendererOrigin] : []),
      ],
      logger: { level: 'info' },
      profileId: 'desktop-studio',
    },
  );
  const address = await runtime.listen({ host: '127.0.0.1', port: 0 });
  desktopParentPort.postMessage({
    type: 'ready',
    baseUrl: address,
    runtimeId: metadata.runtimeId,
    generation: metadata.generation,
    apiVersion: metadata.apiVersion,
  });
}

desktopParentPort.on('message', (event) => {
  const message = event.data;
  if (message.type === 'bootstrap') {
    void bootstrap(message).catch((error) => {
      desktopParentPort.postMessage({
        type: 'fatal',
        message: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 1;
    });
  } else if (message.type === 'shutdown') {
    void runtime?.close().finally(() => process.exit(0));
  } else if (message.type === 'analytics-worker-changed') {
    void (async () => {
      let status = message.status;
      if (message.worker) {
        try {
          analyticsWorkerClient = new AnalyticsWorkerClient(message.worker);
          await analyticsWorkerClient.health();
          status = 'ready';
        } catch {
          analyticsWorkerClient = undefined;
          status = 'degraded';
        }
      } else {
        analyticsWorkerClient = undefined;
      }
      runtime?.setAnalyticsWorker(analyticsWorkerClient, status);
    })();
  } else if (message.type === 'issue-session-nonce') {
    runtime?.issueSessionNonce(message.nonce);
    desktopParentPort.postMessage({ type: 'session-nonce-issued', requestId: message.requestId });
  }
});

process.on('uncaughtException', (error) => {
  desktopParentPort.postMessage({ type: 'fatal', message: error.message });
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  desktopParentPort.postMessage({
    type: 'fatal',
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
