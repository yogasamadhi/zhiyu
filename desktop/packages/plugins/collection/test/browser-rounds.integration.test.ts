import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readdir, writeFile, readFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import { LocalArtifactStore } from '@zhiyun/artifact-store';
import { CrawlerRuntime } from '@zhiyun/crawler-runtime';
import { SqliteDatasetRepository } from '@zhiyun/plugin-datasets';
import { taskCreateSchema, normalizeCrawlPlan, type CrawlBatch } from '@zhiyun/shared';
import type { JobExecutionContext } from '@zhiyun/platform-core';
import { CollectionService, createCollectionJobHandler } from '../src/application/index.js';
import { SqliteCollectionRepository } from '../src/persistence/sqlite/index.js';
import { testEnvironment } from '../../../../../tooling/scripts/test-environment.js';

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of disposals.splice(0).reverse()) await close();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
async function fixture(
  mode: 'loadMore' | 'infinite' = 'loadMore',
  virtual = false,
  maxRecords = 1000,
  dedupe: 'none' | 'fields' = 'none',
  numericPayload = false,
  actionWaitMs = 100,
  disabledAtEnd = false,
) {
  const requested: number[] = [];
  let changed = false;
  let heldPage: number | undefined;
  const heldRequest = deferred();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture');
    if (url.pathname === '/items') {
      const page = Number(url.searchParams.get('page'));
      requested.push(page);
      if (heldPage === page) {
        heldPage = undefined;
        heldRequest.resolve();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.write('{"items":[');
      for (let index = 0; index < 260 + (virtual ? 0 : 2); index++) {
        const id = index >= 260 ? 'duplicate' : `${page}-${index}`;
        const payload = `${changed && page === 1 && index === 0 ? 'changed-' : ''}payload-${id}-${'x'.repeat(1000)}`;
        response.write(`${index ? ',' : ''}${JSON.stringify({ id, payload })}`);
      }
      response.end(']}');
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><html><body><style>article { height: 20px; } #sentinel { height: 2px; }</style>
      <main id="list"></main><button id="more">More</button><div id="sentinel"></div>
      <script>
        let page = 0, busy = false;
        const button = document.querySelector('#more');
        async function load() {
          if (busy || page >= 3) return;
          busy = true;
          const data = await fetch('/items?page=' + (++page)).then(r => r.json());
          if (${virtual}) document.querySelector('main').replaceChildren();
          for (const item of data.items) {
            const article = document.createElement('article');
            article.dataset.id = item.id;
            const p = document.createElement('p'); p.textContent = item.payload; article.append(p);
            document.querySelector('main').append(article);
          }
          if (page === 3) button.${disabledAtEnd ? 'disabled' : 'hidden'} = true;
          busy = false;
        }
        button.addEventListener('click', load);
        if (${mode === 'infinite'}) {
          let initial = true;
          new IntersectionObserver(([entry]) => {
            if (initial) { initial = false; return; }
            if (entry.isIntersecting && page > 0) void load();
          }).observe(document.querySelector('#sentinel'));
        }
        void load();
      </script></body></html>`);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  disposals.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  const origin = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), 'zhiyun-browser-rounds-'));
  disposals.push(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'zhiyun.sqlite3');
  const platform = await openSqlitePlatformRepository({
    dataDirectory: directory,
    filePath,
    graphRevision: 'browser-rounds-test',
  });
  disposals.push(() => platform.close());
  let collection = new SqliteCollectionRepository(filePath);
  const datasets = new SqliteDatasetRepository(filePath);
  disposals.push(() => collection.close());
  disposals.push(() => datasets.close());
  await collection.migrate();
  await datasets.migrate();
  const artifacts = new LocalArtifactStore(directory);
  await artifacts.initialize();
  disposals.push(() => artifacts.close());
  const task = await collection.createTask(
    taskCreateSchema.parse({
      name: 'Browser rounds fixture',
      startUrl: `${origin}/`,
      instruction: 'fixture',
      browserSettings: { enabled: true },
      networkPolicy: { allowPrivateNetworks: true },
      requestSettings: {
        concurrency: 1,
        retries: 0,
        delayMs: 0,
        respectRobotsTxt: false,
        maxRequests: 1,
        timeoutMs: 10000,
      },
      datasetSettings: { mode: 'append', keyFields: [], detectRemoved: false },
    }),
  );
  await collection.createRule(
    task.id,
    'Fixture',
    normalizeCrawlPlan({
      list: {
        mode: 'browser',
        rule: {
          type: 'css',
          container: 'article',
          fields: {
            id: {
              selector: ':scope',
              value: 'attribute',
              attribute: 'data-id',
              dataType: 'string',
            },
            payload: {
              selector: 'p',
              value: 'text',
              dataType: numericPayload ? 'number' : 'string',
            },
          },
        },
      },
      pagination:
        mode === 'loadMore'
          ? { type: mode, selector: '#more', maxClicks: 10, waitMs: actionWaitMs }
          : { type: mode, maxScrolls: 10, waitMs: actionWaitMs },
      dedupe: { strategy: dedupe, fields: dedupe === 'fields' ? ['id'] : [] },
      limits: { maxRecords },
    }),
    'human',
  );
  const old = await datasets.commitRunRecords({
    sourceTaskId: task.id,
    sourceRunId: randomUUID(),
    settings: task.datasetSettings,
    records: [{ sourceUrl: task.startUrl, data: { id: 'old', payload: 'keep-old' } }],
  });
  const run = await collection.createRun(task.id);
  const batches: CrawlBatch[] = [];
  async function execute(attempt = 1, signal = new AbortController().signal, maxAttempts = 2) {
    const crawler = new CrawlerRuntime();
    return createCollectionJobHandler({
      repository: collection,
      service: new CollectionService(collection, datasets),
      artifacts,
      crawler: {
        crawl: (input) =>
          crawler.crawl({
            ...input,
            onBatch: async (batch) => {
              batches.push(batch);
              return input.onBatch!(batch);
            },
          }),
      },
      credentialStore: {
        put: async () => '',
        resolve: async <T>() => undefined as T,
        delete: async () => undefined,
      },
    })({
      job: { id: run.id, payload: { taskId: task.id, runId: run.id }, attempt, maxAttempts },
      signal,
      progress: async () => undefined,
      persisting: async () => undefined,
    } as unknown as JobExecutionContext);
  }
  async function records(runId = run.id) {
    let cursor: string | undefined;
    const result: Array<{ sourceUrl: string; data: Record<string, unknown> }> = [];
    do {
      const page = await datasets.listRunRecords(runId, cursor, 250);
      result.push(...page.items.map(({ sourceUrl, data }) => ({ sourceUrl, data })));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return result.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  return {
    directory,
    task,
    run,
    old,
    datasets,
    artifacts,
    requested,
    batches,
    execute,
    records,
    get collection() {
      return collection;
    },
    async reopen() {
      await collection.close();
      collection = new SqliteCollectionRepository(filePath);
      await collection.migrate();
    },
    holdPage(page: number) {
      heldPage = page;
      return heldRequest.promise;
    },
    change() {
      changed = true;
    },
  };
}

const runFile = promisify(execFile);
type OwnedProcess = { pid: number; parent: number; identity: string };
async function processIdentity(pid: number) {
  try {
    const { stdout } = await runFile('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'comm=']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
async function descendants(parent: number): Promise<OwnedProcess[]> {
  const { stdout } = await runFile('ps', ['-axo', 'pid=,ppid=']);
  const all = stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      return { pid: pid!, parent: ppid! };
    });
  const ids = new Set([parent]);
  const owned: OwnedProcess[] = [];
  for (;;) {
    const next = all.filter((item) => ids.has(item.parent) && !ids.has(item.pid));
    if (!next.length) return owned;
    for (const item of next) {
      ids.add(item.pid);
      const identity = await processIdentity(item.pid);
      if (identity) owned.push({ ...item, identity });
    }
  }
}
async function cleanupOwned(owned: OwnedProcess[]) {
  // The ancestry is recorded while the spawned worker is alive. After SIGKILL,
  // a reparented browser is still ours only if PID/start time/executable match.
  for (const item of [...owned].reverse()) {
    if ((await processIdentity(item.pid)) !== item.identity) continue;
    try {
      process.kill(item.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}
async function browserWorker(
  f: Awaited<ReturnType<typeof fixture>>,
  taskId = f.task.id,
  runId = f.run.id,
  point = 'none',
  attempt = 1,
) {
  const child = spawn(
    process.execPath,
    [
      '--experimental-transform-types',
      '--conditions=development',
      '--import',
      new URL('./fixtures/recovery-loader.mjs', import.meta.url).pathname,
      new URL('./fixtures/browser-round-recovery-worker.ts', import.meta.url).pathname,
      f.directory,
      taskId,
      runId,
      point,
      String(attempt),
    ],
    {
      env: {
        ...testEnvironment(process.env),
        PLAYWRIGHT_BROWSERS_PATH: new URL('../../../../resources/playwright', import.meta.url)
          .pathname,
        CRAWLEE_STORAGE_DIR: join(f.directory, 'child-crawlee'),
        // Playwright's transient profiles/download directories must be inside
        // our fixture even when SIGKILL prevents its normal finally cleanup.
        TMPDIR: f.directory,
        TMP: f.directory,
        TEMP: f.directory,
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
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (!line.startsWith('ZHIYUN_BROWSER_RECOVERY ')) continue;
      const message = JSON.parse(line.slice('ZHIYUN_BROWSER_RECOVERY '.length)) as {
        event: string;
        pid: number;
      };
      if (message.pid !== child.pid) {
        for (const entry of waiting.values()) entry.reject(new Error('Worker PID mismatch'));
        continue;
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
          entry.reject(new Error(`Browser worker exited: ${code}/${signal}. ${errors}`));
        resolve({ code, signal });
      });
    },
  );
  let owned: OwnedProcess[] = [];
  disposals.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      owned = await descendants(child.pid!);
      child.kill('SIGKILL');
    }
    await exited;
    await cleanupOwned(owned);
  });
  async function wait(name: string) {
    if (seen.has(name)) return;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Browser worker is terminal. ${errors}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(name);
        reject(new Error(`Browser event timeout: ${name}. ${errors}`));
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
    async during(promise: Promise<void>) {
      await Promise.race([
        promise,
        exited.then(({ code, signal }) => {
          throw new Error(`Worker ended before the held request: ${code}/${signal}. ${errors}`);
        }),
      ]);
    },
    async finish(name = 'done') {
      await wait(name);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Browser worker teardown did not exit. ${errors}`)),
              5000,
            );
          }),
        ]);
        expect(result).toEqual({ code: 0, signal: null });
      } finally {
        clearTimeout(timer);
      }
    },
    async kill() {
      owned = await descendants(child.pid!);
      expect(owned.some((item) => /chrom(?:e|ium)/i.test(item.identity))).toBe(true);
      expect(
        (await readdir(f.directory)).some((name) =>
          name.startsWith('playwright_chromiumdev_profile-'),
        ),
      ).toBe(true);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(child.kill('SIGKILL')).toBe(true);
      expect(await exited).toEqual({ code: null, signal: 'SIGKILL' });
      await cleanupOwned(owned);
    },
    async killBrowser() {
      owned = await descendants(child.pid!);
      const browser = owned.find(
        (item) => item.parent === child.pid && /chrom(?:e|ium)/i.test(item.identity),
      );
      expect(browser).toBeDefined();
      if (!browser || (await processIdentity(browser.pid)) !== browser.identity)
        throw new Error('Owned Chromium process identity changed');
      process.kill(browser.pid, 'SIGKILL');
      // Chromium helpers inherit its pipes. Close our registered descendants
      // before waiting for Crawlee's browser teardown to finish in the worker.
      await cleanupOwned(owned);
      await this.finish('failed');
    },
  };
}

describe('durable browser action rounds with real Artifact and SQLite', () => {
  it('finishes at a disabled load-more control and commits all streamed rows without another click', async () => {
    const f = await fixture('loadMore', false, 1000, 'none', false, 100, true);
    const complete = f.collection.completeBrowserRound.bind(f.collection);
    const states: boolean[] = [];
    f.collection.completeBrowserRound = async (...args) => {
      states.push(args[4].terminal);
      return complete(...args);
    };
    await f.execute();
    expect(f.requested).toEqual([1, 2, 3]);
    expect(states).toEqual([false, false, true]);
    expect(await f.records()).toHaveLength(786);
    expect((await f.collection.getRun(f.run.id))?.recordCount).toBe(786);
    expect((await f.datasets.getDataset(f.old.dataset.id))?.currentCount).toBe(787);
    expect(await f.datasets.getSnapshot(f.old.snapshot.id)).toEqual(f.old.snapshot);
    expect(
      (await f.collection.listCrawlSessionOwners()).some((item) => item.runId === f.run.id),
    ).toBe(false);
    expect(await readdir(join(f.directory, 'job-workspaces'))).toEqual([]);
  }, 30_000);
  it('normalizes replayed cursor fields and excludes additional page/auth material from SQLite', async () => {
    const f = await fixture();
    const complete = f.collection.completeBrowserRound.bind(f.collection);
    const marker = 'fixture-browser-cursor-private-material';
    let checked = false;
    f.collection.completeBrowserRound = async (...args) => {
      const state = args[4];
      await complete(...(args.slice(0, 4) as [string, string, string, number]), {
        ...state,
        dom: marker,
        cookie: marker,
      } as typeof state);
      // Property order changes must still be recognized as the same completion.
      await complete(...(args.slice(0, 4) as [string, string, string, number]), {
        batchCount: state.batchCount,
        stableRounds: state.stableRounds,
        domHash: state.domHash,
        height: state.height,
        terminal: state.terminal,
      });
      for (const name of ['zhiyun.sqlite3', 'zhiyun.sqlite3-wal']) {
        expect((await readFile(join(f.directory, name))).includes(Buffer.from(marker))).toBe(false);
      }
      checked = true;
    };
    await f.execute();
    expect(checked).toBe(true);
    expect(await f.records()).toHaveLength(786);
  }, 30_000);
  it.each(
    (['loadMore', 'infinite'] as const).flatMap((mode) =>
      [
        'during_request',
        'after_artifact',
        'before_round',
        'after_round',
        'after_final_round',
        'before_request',
        'after_request',
        'browser_kill',
      ].map((point) => ({ mode, point })),
    ),
  )(
    'recovers $mode after real $point process termination with control records and statistics',
    async ({ mode, point }) => {
      const f = await fixture(
        mode,
        false,
        1000,
        'none',
        false,
        ['during_request', 'browser_kill'].includes(point) ? 2000 : 100,
      );
      const controlTask = await f.collection.createTask(
        taskCreateSchema.parse({ ...f.task, name: 'Control process' }),
      );
      const rule = (await f.collection.getActiveRule(f.task.id))!;
      await f.collection.createRule(controlTask.id, 'Control', rule.version.definition, 'human');
      const controlOld = await f.datasets.commitRunRecords({
        sourceTaskId: controlTask.id,
        sourceRunId: randomUUID(),
        settings: controlTask.datasetSettings,
        records: [{ sourceUrl: controlTask.startUrl, data: { id: 'old', payload: 'keep-old' } }],
      });
      const controlRun = await f.collection.createRun(controlTask.id);
      await writeFile(
        join(f.directory, 'recovery-fixture.json'),
        JSON.stringify([
          { taskId: f.task.id, runId: f.run.id },
          { taskId: controlTask.id, runId: controlRun.id },
        ]),
        { mode: 0o600 },
      );
      await (await browserWorker(f, controlTask.id, controlRun.id)).finish();
      const expected = (await f.collection.getRun(controlRun.id))!;
      const expectedRows = await f.records(controlRun.id);
      expect(expectedRows).toHaveLength(786);
      expect((await f.datasets.getDataset(controlOld.dataset.id))?.currentCount).toBe(787);
      f.requested.length = 0;
      const held = ['during_request', 'browser_kill'].includes(point) ? f.holdPage(2) : null;
      const first = await browserWorker(f, f.task.id, f.run.id, point);
      if (held) await first.during(held);
      else await first.wait('fault');
      if (point === 'browser_kill') await first.killBrowser();
      else await first.kill();
      expect((await f.datasets.getDataset(f.old.dataset.id))?.currentCount).toBe(1);
      expect(await f.datasets.getSnapshot(f.old.snapshot.id)).toEqual(f.old.snapshot);
      await f.reopen();
      const before = f.requested.length;
      await (await browserWorker(f, f.task.id, f.run.id, 'none', 2)).finish();
      const actual = (await f.collection.getRun(f.run.id))!;
      expect(actual).toMatchObject({
        status: 'succeeded',
        recordCount: 786,
        requestCount: 1,
        browserUsed: true,
        aiUsed: false,
        datasetStats: expected.datasetStats,
      });
      expect(await f.records()).toEqual(expectedRows);
      expect(await f.datasets.listSnapshots(f.old.dataset.id)).toHaveLength(2);
      expect(await f.datasets.getSnapshot(f.old.snapshot.id)).toEqual(f.old.snapshot);
      expect(f.requested.slice(before)).toEqual(point === 'after_request' ? [] : [1, 2, 3]);
      expect(
        (await f.collection.listCrawlSessionOwners()).some((item) => item.runId === f.run.id),
      ).toBe(false);
      expect(await readdir(join(f.directory, 'job-workspaces'))).toEqual([]);
    },
    60_000,
  );
  it('persists bounded redacted warning messages with their full observed total', async () => {
    const f = await fixture('loadMore', false, 1000, 'none', true);
    await f.execute();
    const run = (await f.collection.getRun(f.run.id))!;
    const warnings = run.metadata.warnings as string[];
    expect(run.recordCount).toBe(786);
    expect(run.metadata.warningTotal).toBe(1572);
    expect(warnings).toHaveLength(128);
    expect(warnings[127]).toBe('Additional warnings omitted: 1445');
    expect(Buffer.byteLength(JSON.stringify(warnings))).toBeLessThanOrEqual(64 * 1024);
    expect((await f.records()).every((record) => record.data.payload === null)).toBe(true);
  }, 30_000);
  it.each(['loadMore', 'infinite'] as const)(
    'streams %s before the next action, retaining duplicate multiplicity and backpressure',
    async (mode) => {
      const f = await fixture(mode);
      const held = deferred();
      const release = deferred();
      const commit = f.artifacts.commitWorkspaceFile.bind(f.artifacts);
      let writes = 0;
      f.artifacts.commitWorkspaceFile = async (...args) => {
        const result = await commit(...args);
        if (args[2].includes('/list/') && ++writes === 1) {
          held.resolve();
          await release.promise;
        }
        return result;
      };
      const execution = f.execute();
      await Promise.race([held.promise, execution]);
      try {
        await new Promise<void>((done) => setTimeout(done, 100));
        expect(f.requested).toEqual([1]);
        expect((await f.datasets.getDataset(f.old.dataset.id))?.currentCount).toBe(1);
        const session = (await f.collection.listCrawlSessionOwners()).find(
          (item) => item.runId === f.run.id,
        )!;
        const request = (await f.collection.listCrawlRequests(f.run.id, session.fingerprint))[0]!;
        await expect(
          f.collection.completeBrowserRound(f.run.id, session.fingerprint, request.id, 0, {
            terminal: true,
            height: 0,
            domHash: 'a'.repeat(64),
            stableRounds: 0,
            batchCount: 0,
          }),
        ).rejects.toThrow('not durably complete');
        await expect(
          f.collection.completeCrawlRequest(
            f.run.id,
            session.fingerprint,
            request.id,
            {
              sourceUrl: f.task.startUrl,
              browserUsed: true,
              nextRequests: [],
            },
            1,
          ),
        ).rejects.toThrow('not durably complete');
      } finally {
        release.resolve();
      }
      await execution;
      const records = await f.records();
      expect(records).toHaveLength(786);
      expect(records.filter((record) => record.data.id === 'duplicate')).toHaveLength(6);
      expect(
        new Set(
          records
            .filter((record) => record.data.id !== 'duplicate')
            .map((record) => record.data.id),
        ).size,
      ).toBe(780);
      expect(records.every((record) => record.sourceUrl === f.task.startUrl)).toBe(true);
      expect(f.requested).toEqual([1, 2, 3]);
      expect(
        f.batches.every(
          (batch) =>
            batch.records.length <= 250 &&
            Buffer.byteLength(JSON.stringify(batch.records)) <= 1024 * 1024,
        ),
      ).toBe(true);
      expect((await f.collection.getRun(f.run.id))?.recordCount).toBe(786);
      expect((await f.collection.getRun(f.run.id))?.requestCount).toBe(1);
      expect((await f.collection.getRun(f.run.id))?.browserUsed).toBe(true);
      expect(await f.datasets.getSnapshot(f.old.snapshot.id)).toEqual(f.old.snapshot);
      expect(await readdir(join(f.directory, 'job-workspaces'))).toEqual([]);
    },
    30_000,
  );
  it.each(['loadMore', 'infinite'] as const)(
    'keeps all unique %s virtual-window rows after earlier DOM rows disappear',
    async (mode) => {
      const f = await fixture(mode, true);
      await f.execute();
      const records = await f.records();
      expect(records).toHaveLength(780);
      expect(new Set(records.map((record) => record.data.id)).size).toBe(780);
      expect(f.requested).toEqual([1, 2, 3]);
    },
    30_000,
  );
  it('cancels during a browser round write without performing another action or replacing old data', async () => {
    const f = await fixture();
    const held = deferred();
    const release = deferred();
    const controller = new AbortController();
    const commit = f.artifacts.commitWorkspaceFile.bind(f.artifacts);
    let first = true;
    f.artifacts.commitWorkspaceFile = async (...args) => {
      const result = await commit(...args);
      if (first && args[2].includes('/list/')) {
        first = false;
        held.resolve();
        await release.promise;
      }
      return result;
    };
    const execution = f.execute(1, controller.signal);
    await Promise.race([held.promise, execution]);
    controller.abort();
    release.resolve();
    await expect(execution).rejects.toMatchObject({ code: 'CANCELED' });
    expect(f.requested).toEqual([1]);
    expect((await f.collection.getRun(f.run.id))?.status).toBe('canceled');
    expect((await f.datasets.getDataset(f.old.dataset.id))?.currentCount).toBe(1);
    expect(await f.datasets.listSnapshots(f.old.dataset.id)).toHaveLength(1);
    expect(
      (await f.collection.listCrawlSessionOwners()).some((item) => item.runId === f.run.id),
    ).toBe(false);
    expect(await readdir(join(f.directory, 'job-workspaces'))).toEqual([]);
  }, 30_000);
  it('stops browser actions at the shared raw record limit and applies the existing fields dedupe on disk', async () => {
    const f = await fixture('loadMore', false, 300, 'fields');
    await f.execute();
    expect(f.requested).toEqual([1, 2]);
    expect((await f.collection.getRun(f.run.id))?.recordCount).toBe(299);
    expect(await f.records()).toHaveLength(299);
    expect(
      (
        await f.datasets.getSnapshot(
          String((await f.collection.getRun(f.run.id))!.metadata.datasetSnapshotId),
        )
      )?.stats.current,
    ).toBe(300);
  }, 30_000);
  it.each([
    'after_artifact',
    'before_round',
    'after_round',
    'after_final_round',
    'before_request',
    'after_request',
  ] as const)(
    'reopens and resumes after %s without duplicate final rows',
    async (point) => {
      const f = await fixture();
      const commit = f.artifacts.commitWorkspaceFile.bind(f.artifacts);
      const round = f.collection.completeBrowserRound.bind(f.collection);
      const complete = f.collection.completeCrawlRequest.bind(f.collection);
      let listWrites = 0;
      let rounds = 0;
      f.artifacts.commitWorkspaceFile = async (...args) => {
        const result = await commit(...args);
        if (args[2].includes('/list/') && ++listWrites === 3 && point === 'after_artifact')
          throw new Error('fixture acknowledgement failure');
        return result;
      };
      f.collection.completeBrowserRound = async (...args) => {
        rounds++;
        if (rounds === 2 && point === 'before_round')
          throw new Error('fixture acknowledgement failure');
        await round(...args);
        if (
          (rounds === 2 && point === 'after_round') ||
          (rounds === 3 && point === 'after_final_round')
        )
          throw new Error('fixture acknowledgement failure');
      };
      f.collection.completeCrawlRequest = async (...args) => {
        if (point === 'before_request') throw new Error('fixture acknowledgement failure');
        const result = await complete(...args);
        if (point === 'after_request') throw new Error('fixture acknowledgement failure');
        return result;
      };
      await expect(f.execute()).rejects.toThrow();
      expect((await f.collection.getRun(f.run.id))?.status).toBe('queued');
      expect((await f.datasets.getDataset(f.old.dataset.id))?.currentCount).toBe(1);
      f.artifacts.commitWorkspaceFile = commit;
      const before = f.requested.length;
      await f.reopen();
      await f.execute(2);
      const records = await f.records();
      expect(records).toHaveLength(786);
      expect(records.filter((record) => record.data.id === 'duplicate')).toHaveLength(6);
      expect(
        new Set(
          records
            .filter((record) => record.data.id !== 'duplicate')
            .map((record) => record.data.id),
        ).size,
      ).toBe(780);
      expect((await f.collection.getRun(f.run.id))?.requestCount).toBe(1);
      expect((await f.collection.getRun(f.run.id))?.datasetStats).toEqual({
        added: 786,
        updated: 0,
        removed: 0,
        unchanged: 0,
        current: 787,
      });
      expect(await f.datasets.listSnapshots(f.old.dataset.id)).toHaveLength(2);
      expect(await f.datasets.getSnapshot(f.old.snapshot.id)).toEqual(f.old.snapshot);
      expect(f.requested.slice(before)).toEqual(point === 'after_request' ? [] : [1, 2, 3]);
    },
    30_000,
  );
  it('rejects changed data while reconstructing a confirmed browser round and preserves the old Snapshot', async () => {
    const f = await fixture();
    const complete = f.collection.completeBrowserRound.bind(f.collection);
    f.collection.completeBrowserRound = async (...args) => {
      await complete(...args);
      throw new Error('fixture acknowledgement failure');
    };
    await expect(f.execute()).rejects.toThrow();
    await f.reopen();
    f.change();
    await expect(f.execute(2, new AbortController().signal, 5)).rejects.toThrow(
      /replay data changed/i,
    );
    expect((await f.collection.getRun(f.run.id))?.status).toBe('failed');
    expect((await f.collection.getRun(f.run.id))?.errorCode).toBe('VALIDATION_ERROR');
    expect((await f.datasets.getDataset(f.old.dataset.id))?.currentCount).toBe(1);
    expect(await f.datasets.listSnapshots(f.old.dataset.id)).toHaveLength(1);
    expect(await f.datasets.getSnapshot(f.old.snapshot.id)).toEqual(f.old.snapshot);
  }, 30_000);
});
