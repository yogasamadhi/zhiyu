import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteCollectionRepository } from '@zhiyun/plugin-collection';
import { SqliteDatasetRepository } from '@zhiyun/plugin-datasets';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import { normalizeCrawlPlan, taskCreateSchema } from '@zhiyun/contracts';
import { testEnvironment } from '../../../../tooling/scripts/test-environment.js';

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const requested: number[] = [];
  let hold = false;
  const requestHeld = deferred();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture');
    if (url.pathname !== '/items') {
      response.writeHead(404).end();
      return;
    }
    const page = Number(url.searchParams.get('page'));
    requested.push(page);
    if (hold && page === 2) {
      hold = false;
      requestHeld.resolve();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.write('{"items":[');
    for (let index = 0; index < 260; index++) {
      const id = index === 259 ? 'common' : `${page}-${index}`;
      response.write(
        `${index ? ',' : ''}${JSON.stringify({ id, payload: `${id}-${'x'.repeat(1000)}` })}`,
      );
    }
    response.end(']}');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  disposals.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  const origin = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), 'zhiyun-queue-recovery-'));
  disposals.push(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'zhiyun.sqlite3');
  const platform = await openSqlitePlatformRepository({
    dataDirectory: directory,
    filePath,
    graphRevision: 'queue-recovery-fixture',
  });
  disposals.push(() => platform.close());
  const collection = new SqliteCollectionRepository(filePath);
  const datasets = new SqliteDatasetRepository(filePath);
  disposals.push(() => collection.close());
  disposals.push(() => datasets.close());
  await collection.migrate();
  await datasets.migrate();
  const identities: Array<{ taskId: string; runId: string }> = [];
  async function create(maxAttempts: number) {
    const task = await collection.createTask(
      taskCreateSchema.parse({
        name: 'Queue recovery fixture',
        startUrl: `${origin}/items?page=1`,
        instruction: 'fixture',
        requestSettings: {
          maxRequests: 3,
          retries: 0,
          concurrency: 1,
          delayMs: 0,
          respectRobotsTxt: false,
          domainRateLimitPerMinute: 10_000,
        },
        networkPolicy: { allowPrivateNetworks: true },
        datasetSettings: { mode: 'snapshot', keyFields: ['id'], detectRemoved: true },
      }),
    );
    await collection.createRule(
      task.id,
      'Fixture',
      normalizeCrawlPlan({
        list: {
          mode: 'http',
          rule: {
            type: 'json',
            container: '$.items[*]',
            fields: {
              id: { path: '$.id', dataType: 'string' },
              payload: { path: '$.payload', dataType: 'string' },
            },
          },
        },
        pagination: {
          type: 'page',
          urlTemplate: `${origin}/items?page={page}`,
          startPage: 1,
          endPage: 3,
          step: 1,
        },
        limits: { maxRecords: 1000 },
      }),
      'human',
    );
    const old = await datasets.commitRunRecords({
      sourceTaskId: task.id,
      sourceRunId: randomUUID(),
      settings: task.datasetSettings,
      records: [{ sourceUrl: task.startUrl, data: { id: 'old', payload: 'keep-old' } }],
    });
    const run = await collection.createRun(task.id, undefined, {
      expectedTaskRevision: task.revision,
      expectedRuleVersionId: (await collection.getActiveRule(task.id))!.version.id,
    });
    await platform.enqueueJob({
      id: run.id,
      ownerPluginId: 'collection',
      type: 'collection.crawl.execute',
      resourceClass: 'browser-heavy',
      payload: { taskId: task.id, runId: run.id },
      maxAttempts,
    });
    identities.push({ taskId: task.id, runId: run.id });
    await writeFile(join(directory, 'recovery-fixture.json'), JSON.stringify(identities));
    return { task, run, old };
  }
  async function rows(datasetId: string) {
    const rows: Array<{ data: Record<string, unknown>; sourceUrl: string }> = [];
    let cursor: string | undefined;
    do {
      const page = await datasets.listRecords(datasetId, cursor, 500);
      rows.push(...page.items.map(({ data, sourceUrl }) => ({ data, sourceUrl })));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return rows.sort((a, b) => String(a.data.id).localeCompare(String(b.data.id)));
  }
  return {
    directory,
    collection,
    datasets,
    platform,
    create,
    rows,
    requested,
    holdPage() {
      hold = true;
      return requestHeld.promise;
    },
  };
}
async function worker(
  f: Awaited<ReturnType<typeof fixture>>,
  identity: Awaited<ReturnType<typeof f.create>>,
  mode: string,
  point: string,
) {
  const child = spawn(
    process.execPath,
    [
      '--experimental-transform-types',
      '--conditions=development',
      '--import',
      new URL('../../plugins/collection/test/fixtures/recovery-loader.mjs', import.meta.url)
        .pathname,
      new URL('./fixtures/queue-recovery-worker.ts', import.meta.url).pathname,
      f.directory,
      identity.task.id,
      identity.run.id,
      mode,
      point,
    ],
    {
      env: {
        ...testEnvironment(process.env),
        CRAWLEE_STORAGE_DIR: join(f.directory, 'child-crawlee'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  child.stdin.end();
  let pending = '';
  let errors = '';
  const seen = new Set<string>();
  const waiting = new Map<string, { resolve(): void; reject(error: Error): void }>();
  child.stderr.on('data', (value: Buffer) => {
    errors = (errors + value.toString()).slice(-8000);
  });
  child.stdout.on('data', (value: Buffer) => {
    pending += value.toString();
    let lineEnd: number;
    while ((lineEnd = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, lineEnd);
      pending = pending.slice(lineEnd + 1);
      if (!line.startsWith('ZHIYUN_QUEUE_RECOVERY ')) continue;
      const message = JSON.parse(line.slice('ZHIYUN_QUEUE_RECOVERY '.length)) as {
        event: string;
        pid: number;
      };
      if (message.pid !== child.pid) {
        for (const entry of waiting.values()) entry.reject(new Error('Worker PID mismatch'));
        return;
      }
      seen.add(message.event);
      waiting.get(message.event)?.resolve();
    }
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', (error) => {
        for (const entry of waiting.values()) entry.reject(error);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        for (const entry of waiting.values())
          entry.reject(new Error(`Worker exited: ${code}/${signal}. ${errors}`));
        resolve({ code, signal });
      });
    },
  );
  disposals.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  async function wait(name: string) {
    if (seen.has(name)) return;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Worker is terminal. ${errors}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(name);
        reject(new Error(`Event timeout: ${name}. ${errors}`));
      }, 25_000);
      waiting.set(name, {
        resolve() {
          clearTimeout(timer);
          waiting.delete(name);
          resolve();
        },
        reject(error) {
          clearTimeout(timer);
          waiting.delete(name);
          reject(error);
        },
      });
    });
  }
  await wait('ready');
  return {
    wait,
    async finish() {
      await wait('done');
      expect(await exited).toEqual({ code: 0, signal: null });
    },
    async kill() {
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(child.kill('SIGKILL')).toBe(true);
      expect(await exited).toEqual({ code: null, signal: 'SIGKILL' });
    },
  };
}

describe('LocalQueue and full Runtime process recovery', () => {
  const points = [
    'during_request',
    'after_artifact',
    'before_checkpoint',
    'after_checkpoint',
    'after_projection',
    'after_run',
  ] as const;
  it.each(
    (['queue', 'runtime'] as const).flatMap((mode) => points.map((point) => ({ mode, point }))),
  )(
    'recovers $mode after SIGKILL at $point with the same data, stats and snapshots',
    async ({ mode, point }) => {
      const f = await fixture();
      const maxAttempts = ['after_projection', 'after_run'].includes(point) ? 1 : 2;
      const control = await f.create(maxAttempts);
      await (await worker(f, control, mode, 'none')).finish();
      const expected = (await f.collection.getRun(control.run.id))!;
      const expectedRows = await f.rows(control.old.dataset.id);
      f.requested.length = 0;
      const interrupted = await f.create(maxAttempts);
      const held = point === 'during_request' ? f.holdPage() : null;
      const first = await worker(f, interrupted, mode, point);
      if (held) await held;
      else await first.wait('fault');
      await first.kill();
      expect(await f.platform.getJob(interrupted.run.id)).toMatchObject({
        attempt: 1,
        maxAttempts,
      });
      expect(['running', 'persisting']).toContain(
        (await f.platform.getJob(interrupted.run.id))!.state,
      );
      const resumed = await worker(f, interrupted, mode, 'none');
      await resumed.finish();
      const actual = (await f.collection.getRun(interrupted.run.id))!;
      expect(actual).toMatchObject({
        status: 'succeeded',
        recordCount: 778,
        requestCount: 3,
        browserUsed: false,
        aiUsed: false,
        datasetStats: expected.datasetStats,
      });
      expect(await f.rows(interrupted.old.dataset.id)).toEqual(expectedRows);
      expect(await f.platform.getJob(interrupted.run.id)).toMatchObject({
        state: 'succeeded',
        attempt: 2,
        maxAttempts: 2,
      });
      expect(f.requested).toEqual(
        ['after_checkpoint', 'after_projection', 'after_run'].includes(point)
          ? [1, 2, 3]
          : [1, 2, 2, 3],
      );
      expect(await f.datasets.listSnapshots(interrupted.old.dataset.id)).toHaveLength(2);
      expect(await f.datasets.getSnapshot(interrupted.old.snapshot.id)).toEqual(
        interrupted.old.snapshot,
      );
      expect(await f.collection.getCrawlCleanup(interrupted.run.id)).toBeNull();
      expect(await f.collection.listCrawlSessionOwners()).toEqual([]);
      expect(await readdir(join(f.directory, 'artifacts', 'collection-batches'))).toEqual([]);
      expect(await readdir(join(f.directory, 'job-workspaces'))).toEqual([]);
      await expect(readFile(join(f.directory, 'recovery-fixture.json'), 'utf8')).resolves.toContain(
        interrupted.run.id,
      );
    },
    60_000,
  );
});
