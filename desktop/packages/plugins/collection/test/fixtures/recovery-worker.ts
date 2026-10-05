import { readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalArtifactStore } from '@zhiyun/artifact-store';
import { CrawlerRuntime } from '@zhiyun/crawler-runtime';
import { SqliteDatasetRepository } from '@zhiyun/plugin-datasets';
import type { JobExecutionContext } from '@zhiyun/platform-core';
import { CollectionService, createCollectionJobHandler } from '../../src/application/index.js';
import { SqliteCollectionRepository } from '../../src/persistence/sqlite/index.js';

const [directoryArg, taskId, runId, point, attemptArg] = process.argv.slice(2);
if (!directoryArg || !taskId || !runId || !point || !attemptArg)
  throw new Error('Invalid recovery worker arguments');
const directory = await realpath(directoryArg);
const location = relative(await realpath(tmpdir()), directory);
if (
  isAbsolute(location) ||
  location.startsWith('..') ||
  !basename(directory).startsWith('zhiyun-streaming-')
)
  throw new Error('Recovery worker requires an owned temporary fixture');
const allowed = JSON.parse(
  await readFile(join(directory, 'recovery-fixture.json'), 'utf8'),
) as Array<{ taskId: string; runId: string }>;
if (!allowed.some((item) => item.taskId === taskId && item.runId === runId))
  throw new Error('Recovery worker IDs are not registered in the fixture');

const repository = new SqliteCollectionRepository(join(directory, 'zhiyun.sqlite3'));
const datasets = new SqliteDatasetRepository(join(directory, 'zhiyun.sqlite3'));
const artifacts = new LocalArtifactStore(directory);
const event = (name: string) =>
  process.stdout.write(
    `ZHIYUN_RECOVERY ${JSON.stringify({ event: name, point, pid: process.pid })}\n`,
  );
const stop = async () => {
  setInterval(() => undefined, 1000);
  event('fault');
  await new Promise<void>(() => undefined);
};
try {
  await repository.migrate();
  await datasets.migrate();
  await artifacts.initialize();
  const task = await repository.getTask(taskId);
  if (!task || new URL(task.startUrl).hostname !== '127.0.0.1')
    throw new Error('Recovery worker only accepts its localhost fixture task');
  const commit = artifacts.commitWorkspaceFile.bind(artifacts);
  let listArtifacts = 0;
  artifacts.commitWorkspaceFile = async (...args) => {
    const result = await commit(...args);
    if (args[2].includes('/list/') || args[2].includes('/discovery/')) listArtifacts++;
    if (point === 'after_artifact' && listArtifacts === 3) await stop();
    return result;
  };
  const discover = repository.stageSitemapBatch.bind(repository);
  let discoveryBatches = 0;
  repository.stageSitemapBatch = async (...args) => {
    await discover(...args);
    discoveryBatches++;
    if (point === 'after_discovery_stage' && discoveryBatches === 3) await stop();
  };
  const complete = repository.completeCrawlRequest.bind(repository);
  let checkpoints = 0;
  repository.completeCrawlRequest = async (...args) => {
    checkpoints++;
    if (point === 'before_checkpoint' && checkpoints === 2) await stop();
    const result = await complete(...args);
    if (point === 'after_checkpoint' && checkpoints === 2) await stop();
    return result;
  };
  const project = datasets.commitIngestion.bind(datasets);
  datasets.commitIngestion = async (...args) => {
    const result = await project(...args);
    if (point === 'after_projection') await stop();
    return result;
  };
  event('ready');
  await createCollectionJobHandler({
    repository,
    service: new CollectionService(repository, datasets),
    artifacts,
    crawler: new CrawlerRuntime(),
    credentialStore: {
      put: async () => '',
      resolve: async <T>() => undefined as T,
      delete: async () => undefined,
    },
  })({
    job: { id: runId, payload: { taskId, runId }, attempt: Number(attemptArg), maxAttempts: 2 },
    signal: new AbortController().signal,
    progress: async () => undefined,
    persisting: async () => undefined,
  } as unknown as JobExecutionContext);
  event('done');
} finally {
  await artifacts.close();
  await datasets.close();
  await repository.close();
}
