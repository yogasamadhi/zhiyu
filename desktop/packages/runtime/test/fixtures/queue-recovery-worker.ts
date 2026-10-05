import { readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createAiProvider } from '@zhiyun/ai-runtime';
import { LocalArtifactStore } from '@zhiyun/artifact-store';
import { CrawlerRuntime } from '@zhiyun/crawler-runtime';
import { JobHandlerRegistry } from '@zhiyun/platform-core';
import {
  CollectionBatchCleanup,
  CollectionService,
  SqliteCollectionRepository,
  createCollectionJobHandler,
} from '@zhiyun/plugin-collection';
import { SqliteDatasetRepository } from '@zhiyun/plugin-datasets';
import { SqliteAnalysisRepository } from '@zhiyun/plugin-analytics';
import { SqliteAiConversationRepository } from '@zhiyun/plugin-ai-assistance';
import { SqliteCorpusRepository } from '@zhiyun/plugin-corpus';
import { SqliteMonitoringRepository } from '@zhiyun/plugin-monitoring';
import { SqliteOutputRepository } from '@zhiyun/plugin-outputs';
import { SqlitePreferencesRepository } from '@zhiyun/plugin-preferences';
import { SqliteRecruitmentRepository } from '@zhiyun/plugin-recruitment';
import { LocalPlatformJobQueue } from '@zhiyun/queue-local-v1';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import { buildLevel2Runtime, openApiDocument } from '../../src/index.js';

const [directoryArg, taskId, runId, mode, point] = process.argv.slice(2);
if (!directoryArg || !taskId || !runId || !['queue', 'runtime'].includes(mode ?? '') || !point)
  throw new Error('Invalid queue recovery arguments');
const directory = await realpath(directoryArg);
const childPath = relative(await realpath(tmpdir()), directory);
if (
  isAbsolute(childPath) ||
  childPath.startsWith('..') ||
  !basename(directory).startsWith('zhiyun-queue-recovery-')
)
  throw new Error('Requires an owned queue recovery fixture');
const allowed = JSON.parse(
  await readFile(join(directory, 'recovery-fixture.json'), 'utf8'),
) as Array<{ taskId: string; runId: string }>;
if (!allowed.some((item) => item.taskId === taskId && item.runId === runId))
  throw new Error('Unregistered queue recovery identity');
const filePath = join(directory, 'zhiyun.sqlite3');
const platform = await openSqlitePlatformRepository({
  dataDirectory: directory,
  filePath,
  graphRevision: 'queue-recovery-fixture',
});
const collection = new SqliteCollectionRepository(filePath);
const datasets = new SqliteDatasetRepository(filePath);
const artifacts = new LocalArtifactStore(directory);
const handlers = new JobHandlerRegistry();
const jobs = new LocalPlatformJobQueue(platform, handlers, {
  pollIntervalMs: 20,
  recoveryIntervalMs: 20,
  leaseMs: 750,
});
const cleanup = new CollectionBatchCleanup(
  { repository: collection, datasets, artifacts, jobs },
  20,
);
const credentials = {
  put: async () => '',
  resolve: async <T>() => undefined as T,
  delete: async () => undefined,
};
const event = (name: string) =>
  process.stdout.write(
    `ZHIYUN_QUEUE_RECOVERY ${JSON.stringify({ event: name, pid: process.pid, mode, point })}\n`,
  );
const stop = async () => {
  event('fault');
  await new Promise<void>(() => undefined);
};
let close: () => Promise<void> = async () => {
  await cleanup.close();
  await jobs.close();
  await artifacts.close();
  await collection.close();
  await datasets.close();
  await platform.close();
};
try {
  await collection.migrate();
  await datasets.migrate();
  await artifacts.initialize();
  const task = await collection.getTask(taskId);
  if (!task || new URL(task.startUrl).hostname !== '127.0.0.1')
    throw new Error('Requires the registered localhost task');
  let batches = 0;
  const commit = artifacts.commitWorkspaceFile.bind(artifacts);
  artifacts.commitWorkspaceFile = async (...args) => {
    const result = await commit(...args);
    if (args[2].includes(`collection-batches/${runId}/list/`)) {
      batches++;
      if (point === 'after_artifact' && batches === 3) await stop();
    }
    return result;
  };
  let checkpoints = 0;
  const checkpoint = collection.completeCrawlRequest.bind(collection);
  collection.completeCrawlRequest = async (...args) => {
    if (args[0] === runId) {
      checkpoints++;
      if (point === 'before_checkpoint' && checkpoints === 2) await stop();
    }
    const result = await checkpoint(...args);
    if (args[0] === runId && point === 'after_checkpoint' && checkpoints === 2) await stop();
    return result;
  };
  const project = datasets.commitIngestion.bind(datasets);
  datasets.commitIngestion = async (...args) => {
    const result = await project(...args);
    if (args[0] === runId && point === 'after_projection') await stop();
    return result;
  };
  const completeRun = collection.completeRun.bind(collection);
  collection.completeRun = async (...args) => {
    const result = await completeRun(...args);
    if (args[0] === runId && point === 'after_run') await stop();
    return result;
  };
  if (mode === 'queue') {
    handlers.register({
      ownerPluginId: 'collection',
      type: 'collection.crawl.execute',
      resourceClass: 'browser-heavy',
      handler: createCollectionJobHandler({
        repository: collection,
        service: new CollectionService(collection, datasets),
        crawler: new CrawlerRuntime(),
        artifacts,
        credentialStore: credentials,
      }),
    });
    jobs.start();
    await cleanup.start();
  } else {
    const ai = createAiProvider();
    if (ai.name !== 'mock') throw new Error('Runtime recovery fixture requires Mock AI');
    const runtime = await buildLevel2Runtime(
      {
        repositories: {
          platform,
          collection,
          datasets,
          analytics: new SqliteAnalysisRepository(filePath),
          aiAssistance: new SqliteAiConversationRepository(filePath),
          corpus: new SqliteCorpusRepository(filePath),
          monitoring: new SqliteMonitoringRepository(filePath),
          outputs: new SqliteOutputRepository(filePath),
          preferences: new SqlitePreferencesRepository(filePath),
          recruitment: new SqliteRecruitmentRepository(filePath),
        },
        handlers,
        jobs,
        crawler: new CrawlerRuntime(),
        ai,
        credentialStore: credentials,
        artifactStore: artifacts,
        openApiDocument: openApiDocument('test'),
        host: {
          metadata: {
            runtimeId: crypto.randomUUID(),
            generation: 1,
            apiVersion: 'v2',
            mode: 'desktop',
            productVersion: '1.0.0',
            analyticsWorkerStatus: 'unavailable',
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
        profileId: 'test',
        sessionNonce: 'queue-recovery-fixture',
        allowedOrigins: ['app://zhiyun'],
        logger: false,
      },
    );
    close = () => runtime.close();
    await runtime.app.ready();
  }
  event('ready');
  const deadline = Date.now() + 20_000;
  for (;;) {
    const job = await jobs.get(runId);
    if (
      job?.state === 'succeeded' &&
      (await collection.getRun(runId))?.status === 'succeeded' &&
      !(await collection.getCrawlCleanup(runId))
    )
      break;
    if (Date.now() > deadline)
      throw new Error('Queue recovery did not complete within its fixture deadline');
    await new Promise<void>((done) => setTimeout(done, 20));
  }
  event('done');
} finally {
  await close();
}
