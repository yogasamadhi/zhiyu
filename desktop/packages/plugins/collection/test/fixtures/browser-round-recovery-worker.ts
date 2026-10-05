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
if (!directoryArg || !taskId || !runId || !point || !['1', '2'].includes(attemptArg ?? ''))
  throw new Error('Invalid browser recovery arguments');
const directory = await realpath(directoryArg);
const location = relative(await realpath(tmpdir()), directory);
if (
  isAbsolute(location) ||
  location.startsWith('..') ||
  !basename(directory).startsWith('zhiyun-browser-rounds-')
)
  throw new Error('Requires an owned browser recovery fixture');
const registered = JSON.parse(
  await readFile(join(directory, 'recovery-fixture.json'), 'utf8'),
) as Array<{ taskId: string; runId: string }>;
if (!registered.some((entry) => entry.taskId === taskId && entry.runId === runId))
  throw new Error('Unregistered browser recovery identity');

const filePath = join(directory, 'zhiyun.sqlite3');
const repository = new SqliteCollectionRepository(filePath);
const datasets = new SqliteDatasetRepository(filePath);
const artifacts = new LocalArtifactStore(directory);
function event(name: string) {
  process.stdout.write(
    `ZHIYUN_BROWSER_RECOVERY ${JSON.stringify({ event: name, pid: process.pid, point })}\n`,
  );
}
async function stop() {
  event('fault');
  setInterval(() => undefined, 1000);
  await new Promise<void>(() => undefined);
}
try {
  await repository.migrate();
  await datasets.migrate();
  await artifacts.initialize();
  const task = await repository.getTask(taskId);
  if (!task || new URL(task.startUrl).hostname !== '127.0.0.1' || !task.browserSettings.enabled)
    throw new Error('Requires the registered localhost browser task');
  const commit = artifacts.commitWorkspaceFile.bind(artifacts);
  let listBatches = 0;
  artifacts.commitWorkspaceFile = async (...args) => {
    const result = await commit(...args);
    if (args[2].includes(`collection-batches/${runId}/list/`)) {
      if (++listBatches === 3 && point === 'after_artifact') await stop();
    }
    return result;
  };
  const completeRound = repository.completeBrowserRound.bind(repository);
  let rounds = 0;
  repository.completeBrowserRound = async (...args) => {
    rounds++;
    if (rounds === 2 && point === 'before_round') await stop();
    await completeRound(...args);
    if (
      (rounds === 2 && point === 'after_round') ||
      (args[4].terminal && point === 'after_final_round')
    )
      await stop();
  };
  const completeRequest = repository.completeCrawlRequest.bind(repository);
  repository.completeCrawlRequest = async (...args) => {
    if (point === 'before_request') await stop();
    const result = await completeRequest(...args);
    if (point === 'after_request') await stop();
    return result;
  };
  event('ready');
  try {
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
  } catch (error) {
    if (point !== 'browser_kill') throw error;
    if ((await repository.getRun(runId))?.status !== 'queued') throw error;
    event('failed');
  }
} finally {
  await artifacts.close();
  await datasets.close();
  await repository.close();
  event('closed');
}
