import { once } from 'node:events';
import { stat, realpath, readdir } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalArtifactStore } from '../../packages/capabilities/artifact-store/src/index.js';
import { CrawlerRuntime } from '../../packages/crawler-runtime/src/index.js';
import type { JobExecutionContext } from '../../packages/platform-core/src/index.js';
import {
  CollectionService,
  SqliteCollectionRepository,
  createCollectionJobHandler,
} from '../../packages/plugins/collection/src/index.js';
import { SqliteDatasetRepository } from '../../packages/plugins/datasets/src/index.js';
import { openSqlitePlatformRepository } from '../../packages/capabilities/storage-sqlite/src/index.js';
import { normalizeCrawlPlan, taskCreateSchema } from '../../packages/shared/src/index.js';

const [origin, countArg, directoryArg] = process.argv.slice(2);
if (!origin || !countArg || !directoryArg) throw new Error('Invalid pipeline benchmark arguments');
const total = Number(countArg);
if (![10_000, 100_000].includes(total) || new URL(origin).hostname !== '127.0.0.1')
  throw new Error('Pipeline benchmark requires its localhost fixture and standard counts');
const directory = await realpath(directoryArg);
const location = relative(await realpath(tmpdir()), directory);
if (
  isAbsolute(location) ||
  location.startsWith('..') ||
  !basename(directory).startsWith('zhiyun-collection-benchmark-')
)
  throw new Error('Pipeline benchmark requires an owned temporary directory');
const filePath = join(directory, 'zhiyun.sqlite3');
const platform = await openSqlitePlatformRepository({
  dataDirectory: directory,
  filePath,
  graphRevision: 'collection-resource-benchmark',
});
const collection = new SqliteCollectionRepository(filePath);
const datasets = new SqliteDatasetRepository(filePath);
const artifacts = new LocalArtifactStore(directory);
let timer: ReturnType<typeof setInterval> | undefined;
try {
  await collection.migrate();
  await datasets.migrate();
  await artifacts.initialize();
  const pageSize = 1000;
  const pages = total / pageSize;
  const task = await collection.createTask(
    taskCreateSchema.parse({
      name: 'Collection resource fixture',
      startUrl: `${origin}/records?page=1`,
      instruction: 'fixture',
      requestSettings: {
        retries: 0,
        delayMs: 0,
        respectRobotsTxt: false,
        concurrency: 1,
        domainRateLimitPerMinute: 10_000,
        maxRequests: pages,
        maxRuntimeMs: 300_000,
      },
      browserSettings: { enabled: false },
      networkPolicy: { allowPrivateNetworks: true },
      datasetSettings: { mode: 'snapshot', keyFields: ['id'], detectRemoved: true },
    }),
  );
  await collection.createRule(
    task.id,
    'Resource fixture',
    normalizeCrawlPlan({
      list: {
        mode: 'http',
        rule: {
          type: 'json',
          container: '$.items[*]',
          fields: {
            id: { path: '$.id', dataType: 'string' },
            name: { path: '$.name', dataType: 'string' },
            payload: { path: '$.payload', dataType: 'string' },
          },
        },
      },
      pagination: {
        type: 'page',
        urlTemplate: `${origin}/records?page={page}`,
        startPage: 1,
        maxPages: pages,
      },
      dedupe: { strategy: 'none', fields: [] },
      limits: { maxRecords: total },
    }),
    'human',
  );
  const run = await collection.createRun(task.id);
  let sampledPeakRssBytes = 0;
  const sample = () => {
    sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss);
  };
  let maxBatchRows = 0;
  let maxBatchBytes = 0;
  let batchCount = 0;
  const stage = datasets.stageBatch.bind(datasets);
  datasets.stageBatch = async (input) => {
    batchCount++;
    maxBatchRows = Math.max(maxBatchRows, input.records.length);
    maxBatchBytes = Math.max(maxBatchBytes, Buffer.byteLength(JSON.stringify(input.records)));
    sample();
    const result = await stage(input);
    sample();
    return result;
  };
  let artifactFileCount = 0;
  let artifactWrittenBytes = 0;
  const commitFile = artifacts.commitWorkspaceFile.bind(artifacts);
  artifacts.commitWorkspaceFile = async (...args) => {
    const result = await commitFile(...args);
    artifactFileCount++;
    artifactWrittenBytes += result.size;
    sample();
    return result;
  };
  let projectionMs = 0;
  let beforeProjectionRssBytes = 0;
  let afterProjectionRssBytes = 0;
  let beforeProjectionHeapUsedBytes = 0;
  let afterProjectionHeapUsedBytes = 0;
  const project = datasets.commitIngestion.bind(datasets);
  datasets.commitIngestion = async (...args) => {
    beforeProjectionRssBytes = process.memoryUsage().rss;
    beforeProjectionHeapUsedBytes = process.memoryUsage().heapUsed;
    const started = performance.now();
    const result = await project(...args);
    projectionMs += performance.now() - started;
    afterProjectionRssBytes = process.memoryUsage().rss;
    afterProjectionHeapUsedBytes = process.memoryUsage().heapUsed;
    sample();
    return result;
  };
  const handler = createCollectionJobHandler({
    repository: collection,
    service: new CollectionService(collection, datasets),
    artifacts,
    crawler: new CrawlerRuntime(),
    credentialStore: {
      put: async () => '',
      resolve: async <T>() => undefined as T,
      delete: async () => undefined,
    },
  });
  (globalThis as { gc?: () => void }).gc?.();
  const initialRssBytes = process.memoryUsage().rss;
  const initialPeakRssBytes = process.resourceUsage().maxRSS * 1024;
  sampledPeakRssBytes = initialRssBytes;
  process.stdout.write(
    `ZHIYUN_BENCH ${JSON.stringify({ ready: true, initialRssBytes, initialPeakRssBytes })}\n`,
  );
  await once(process.stdin, 'data');
  process.stdin.pause();
  timer = setInterval(sample, 20);
  const started = performance.now();
  await handler({
    job: { id: run.id, payload: { taskId: task.id, runId: run.id }, attempt: 1, maxAttempts: 1 },
    signal: new AbortController().signal,
    progress: async () => sample(),
    persisting: async () => sample(),
  } as unknown as JobExecutionContext);
  sample();
  const elapsedMs = performance.now() - started;
  const resourcePeakRssBytes = process.resourceUsage().maxRSS * 1024;
  clearInterval(timer);
  timer = undefined;
  process.stdout.write('ZHIYUN_BENCH {"measured":true}\n');
  // Validation is bounded and starts after the measured handler has finished.
  const finished = await collection.getRun(run.id);
  const dataset = await datasets.getDatasetBySourceTask(task.id);
  if (
    finished?.status !== 'succeeded' ||
    finished.recordCount !== total ||
    finished.requestCount !== pages ||
    finished.browserUsed ||
    finished.aiUsed ||
    dataset?.currentCount !== total
  )
    throw new Error('Production pipeline result does not match the HTTP fixture');
  const snapshots = await datasets.listSnapshots(dataset.id);
  const snapshot = snapshots[0];
  if (
    snapshots.length !== 1 ||
    snapshot?.rowCount !== total ||
    snapshot.stats.added !== total ||
    snapshot.stats.current !== total ||
    snapshot.stats.updated ||
    snapshot.stats.removed ||
    snapshot.stats.unchanged
  )
    throw new Error('Production pipeline Snapshot statistics differ from the fixture');
  let cursor: string | undefined;
  let checkedRecords = 0;
  const seen = new Uint8Array(total);
  do {
    const page = await datasets.listRunRecords(run.id, cursor, 500);
    for (const record of page.items) {
      const id = Number(record.data.id);
      if (
        !Number.isSafeInteger(id) ||
        id < 0 ||
        id >= total ||
        seen[id] ||
        record.data.id !== String(id).padStart(8, '0') ||
        record.data.name !== 'Fixture' ||
        typeof record.data.payload !== 'string' ||
        !/^x+$/.test(record.data.payload) ||
        Buffer.byteLength(JSON.stringify(record.data)) !== 1024 ||
        record.sourceUrl !== `${origin}/records?page=${Math.floor(id / pageSize) + 1}`
      )
        throw new Error(
          'Persisted record content, identity or source URL differs from the fixture',
        );
      seen[id] = 1;
      checkedRecords++;
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  if (checkedRecords !== total || seen.some((value) => value !== 1))
    throw new Error('Persisted records are missing or duplicated');
  if (maxBatchRows > 250 || maxBatchBytes > 1024 * 1024 || batchCount !== total / 250)
    throw new Error('Production pipeline exceeded its bounded batch contract');
  const remainingArtifacts = await readdir(join(directory, 'artifacts/collection-batches'));
  const remainingWorkspaces = await readdir(join(directory, 'job-workspaces'));
  if (remainingArtifacts.length || remainingWorkspaces.length)
    throw new Error('Successful handler left its temporary Artifact or workspace behind');
  const sqliteBytes = (await stat(filePath)).size;
  const sqliteWalBytes = (await stat(`${filePath}-wal`)).size;
  process.stdout.write(
    `ZHIYUN_BENCH ${JSON.stringify({ complete: true, mode: 'pipeline', total, pageSize, recordBytes: 1024, initialRssBytes, initialPeakRssBytes, sampledPeakRssBytes, resourcePeakRssBytes, elapsedMs, projectionMs, beforeProjectionRssBytes, afterProjectionRssBytes, beforeProjectionHeapUsedBytes, afterProjectionHeapUsedBytes, recordsPerSecond: total / (elapsedMs / 1000), requestCount: finished.requestCount, browserRequests: 0, pythonProcesses: 0, maxBatchRows, maxBatchBytes, batchCount, artifactFileCount, artifactWrittenBytes, sqliteBytes, sqliteWalBytes, checkedRecords, snapshotStats: snapshot.stats, runtime: process.version })}\n`,
  );
} finally {
  if (timer) clearInterval(timer);
  await artifacts.close();
  await datasets.close();
  await collection.close();
  await platform.close();
}
