import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import { LocalArtifactStore } from '@zhiyun/artifact-store';
import { CrawlerRuntime } from '@zhiyun/crawler-runtime';
import { SqliteDatasetRepository } from '@zhiyun/plugin-datasets';
import { taskCreateSchema, normalizeCrawlPlan, type CrawlBatch } from '@zhiyun/shared';
import type { JobExecutionContext } from '@zhiyun/platform-core';
import { testEnvironment } from '../../../../../tooling/scripts/test-environment.js';
import { CollectionService, createCollectionJobHandler } from '../src/application/index.js';
import { SqliteCollectionRepository } from '../src/persistence/sqlite/index.js';

const cleanups: Array<() => Promise<void>> = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse())
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  vi.restoreAllMocks();
  if (errors.length) throw new AggregateError(errors, 'Streaming fixture cleanup failed');
});

async function fixture(
  mode: 'http' | 'browser' | 'html' | 'sitemap' = 'http',
  details = false,
  maxRecords = 1000,
) {
  const requestedPages: number[] = [];
  const detailsRequested: string[] = [];
  let heldPage: number | null = null;
  let authorization: string | null = null;
  let failedDetail: string | null = null;
  let emptySitemapPage: number | null = null;
  const heldRequest = deferred();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture');
    if (authorization && request.headers.authorization !== authorization) {
      response.writeHead(403).end('fixture authentication required');
      return;
    }
    if (url.pathname.startsWith('/detail/')) {
      const id = url.pathname.slice('/detail/'.length);
      detailsRequested.push(id);
      if (id === failedDetail) {
        response.writeHead(503).end('fixture detail failure');
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ id, description: `detail-${id}` }));
      return;
    }
    if (
      mode === 'sitemap' &&
      (url.pathname === '/sitemap.xml' || /^\/child-[12]\.xml$/.test(url.pathname))
    ) {
      const page = url.pathname === '/sitemap.xml' ? 0 : Number(url.pathname.slice(7, 8));
      requestedPages.push(page);
      if (heldPage === page) {
        heldPage = null;
        heldRequest.resolve();
        return;
      }
      const source = `http://${request.headers.host}`;
      response.setHeader('content-type', 'application/xml');
      if (page === 0) {
        response.end(
          `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['child-1.xml', 'sitemap.xml', 'child-1.xml', 'child-2.xml'].map((path) => `<sitemap><loc>${source}/${path}</loc></sitemap>`).join('')}</sitemapindex>`,
        );
        return;
      }
      response.write('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
      if (emptySitemapPage !== page)
        for (let index = 0; index < 260; index++) {
          const id = index === 259 ? 'common' : `${page}-${index}`;
          const modified = new Date(
            Date.UTC(2026, 0, page * 10) + (index === 11 ? 10 : index) * 3600000,
          ).toISOString();
          response.write(
            `<url><loc>${source}/detail/${id}</loc>${index === 258 ? '' : `<lastmod>${modified}</lastmod>`}</url>`,
          );
        }
      response.end('</urlset>');
      return;
    }
    if (url.pathname !== '/records') {
      response.writeHead(404).end();
      return;
    }
    const page = Number(url.searchParams.get('page'));
    requestedPages.push(page);
    if (heldPage === page) {
      heldPage = null;
      heldRequest.resolve();
      return;
    }
    response.setHeader('content-type', mode === 'http' ? 'application/json' : 'text/html');
    response.write(mode === 'http' ? '{"items":[' : '<!doctype html><html><body>');
    for (let index = 0; index < 260; index++) {
      const id = index === 259 ? 'common' : `${page}-${index}`;
      const payload = `payload-${id}-${'x'.repeat(1000)}`;
      const record = { id, payload, detailUrl: `/detail/${id}` };
      response.write(
        mode === 'http'
          ? `${index ? ',' : ''}${JSON.stringify(record)}`
          : `<article data-id="${id}"><p>${payload}</p><a href="/detail/${id}">detail</a></article>`,
      );
    }
    response.end(
      mode === 'http'
        ? ']}'
        : `${page < 3 ? `<a class="next" href="/records?page=${page + 1}">next</a>` : ''}</body></html>`,
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  const origin = `http://127.0.0.1:${address.port}`;
  const directory = await mkdtemp(join(tmpdir(), 'zhiyun-streaming-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'zhiyun.sqlite3');
  const platform = await openSqlitePlatformRepository({
    dataDirectory: directory,
    filePath,
    graphRevision: 'streaming-test',
  });
  cleanups.push(() => platform.close());
  let collection = new SqliteCollectionRepository(filePath);
  let datasets = new SqliteDatasetRepository(filePath);
  cleanups.push(() => collection.close());
  cleanups.push(() => datasets.close());
  await collection.migrate();
  await datasets.migrate();
  const artifacts = new LocalArtifactStore(directory);
  await artifacts.initialize();
  cleanups.push(() => artifacts.close());
  const task = await collection.createTask(
    taskCreateSchema.parse({
      name: 'Streaming fixture',
      startUrl: mode === 'sitemap' ? `${origin}/sitemap.xml` : `${origin}/records?page=1`,
      instruction: 'fixture',
      requestSettings: {
        concurrency: 1,
        retries: 0,
        delayMs: 0,
        respectRobotsTxt: false,
        domainRateLimitPerMinute: 10000,
        maxRequests: details ? 1000 : 3,
      },
      browserSettings: { enabled: mode === 'browser' },
      networkPolicy: { allowPrivateNetworks: true },
      datasetSettings: {
        mode: 'snapshot',
        keyFields: [mode === 'sitemap' ? 'detailUrl' : 'id'],
        detectRemoved: true,
      },
    }),
  );
  const definition = normalizeCrawlPlan({
    list: {
      mode: mode === 'html' || mode === 'sitemap' ? 'http' : mode,
      rule:
        mode === 'http' || mode === 'sitemap'
          ? {
              type: 'json',
              container: '$.items[*]',
              fields: {
                id: { path: '$.id', dataType: 'string' },
                payload: { path: '$.payload', dataType: 'string' },
                ...(details || mode === 'sitemap'
                  ? { detailUrl: { path: '$.detailUrl', dataType: 'url' as const } }
                  : {}),
              },
            }
          : {
              type: 'css',
              container: 'article',
              fields: {
                id: {
                  selector: ':scope',
                  value: 'attribute',
                  attribute: 'data-id',
                  dataType: 'string',
                },
                payload: { selector: 'p', value: 'text', dataType: 'string' },
              },
            },
    },
    ...(mode === 'sitemap'
      ? {
          discovery: {
            type: 'sitemap',
            urlField: 'detailUrl',
            lastModifiedField: 'modified',
            maxDepth: 1,
            maxSitemaps: 3,
            maxUrls: 1000,
            sameOrigin: true,
            include: ['/detail/'],
            exclude: [],
          },
        }
      : {}),
    pagination: {
      type: 'page',
      urlTemplate: `${origin}/records?page={page}`,
      startPage: 1,
      maxPages: 3,
    },
    dedupe: { strategy: 'fields', fields: [mode === 'sitemap' ? 'detailUrl' : 'id'] },
    limits: { maxRecords },
    ...(details
      ? {
          detail: {
            urlField: 'detailUrl',
            mode: 'http',
            rule: {
              type: 'json',
              container: '$',
              fields: {
                description: { path: '$.description', dataType: 'string' },
                ...(mode === 'sitemap'
                  ? { id: { path: '$.id', dataType: 'string' as const } }
                  : {}),
              },
            },
            actions: [],
            mergeStrategy: 'detailWins',
            onError: 'fail-run',
            concurrency: 8,
          },
        }
      : {}),
  });
  await collection.createRule(task.id, 'fixture', definition, 'human');
  const old = await datasets.commitRunRecords({
    sourceTaskId: task.id,
    sourceRunId: randomUUID(),
    settings: task.datasetSettings,
    records: [{ sourceUrl: task.startUrl, data: { id: 'old', payload: 'keep-old' } }],
  });
  const oldSnapshot = await datasets.getSnapshot(old.snapshot.id);
  const workspace = await artifacts.openWorkspace('unrelated');
  await writeFile(await workspace.resolve('manifest.json'), 'unrelated-snapshot');
  await artifacts.commitWorkspaceFile(
    'unrelated',
    'manifest.json',
    'datasets/old-snapshot/manifest.json',
  );
  await artifacts.removeWorkspace('unrelated');
  const run = await collection.createRun(task.id);
  const emitted: CrawlBatch[] = [];
  const emittedUrls: string[] = [];
  const observedRows: number[] = [];
  const runtime = new CrawlerRuntime();
  const persisting = vi.fn(async () => undefined);
  const credentialStore = {
    put: async () => '',
    resolve: async <T>() => undefined as T,
    delete: async () => undefined,
  };
  const execute = (
    attempt = 1,
    signal = new AbortController().signal,
    payload = { taskId: task.id, runId: run.id },
  ) =>
    createCollectionJobHandler({
      repository: collection,
      service: new CollectionService(collection, datasets),
      artifacts,
      credentialStore,
      crawler: {
        crawl: async (input) => {
          const result = await runtime.crawl({
            ...input,
            onBatch: async (batch) => {
              observedRows.push(batch.records.length);
              // Retain only identifiers/counts, never all result rows in this test observer.
              emitted.push({ ...batch, records: [] });
              emittedUrls.push(...batch.records.map((record) => record.sourceUrl));
              return input.onBatch!(batch);
            },
          });
          expect(result.records).toEqual([]);
          return result;
        },
      },
    })({
      job: { id: run.id, payload, attempt, maxAttempts: 2 },
      signal,
      progress: async () => undefined,
      persisting,
    } as unknown as JobExecutionContext);
  return {
    directory,
    artifacts,
    task,
    run,
    old,
    oldSnapshot,
    definition,
    requestedPages,
    detailsRequested,
    emitted,
    emittedUrls,
    observedRows,
    persisting,
    credentialStore,
    requireAuthorization(value: string) {
      authorization = value;
    },
    failDetail(value: string | null) {
      failedDetail = value;
    },
    emptySitemap(page: number | null) {
      emptySitemapPage = page;
    },
    holdPage(page: number) {
      heldPage = page;
      return heldRequest.promise;
    },
    execute,
    get collection() {
      return collection;
    },
    get datasets() {
      return datasets;
    },
    async reopen() {
      await collection.close();
      await datasets.close();
      collection = new SqliteCollectionRepository(filePath);
      datasets = new SqliteDatasetRepository(filePath);
      await collection.migrate();
      await datasets.migrate();
    },
    async assertClean() {
      await expect(
        artifacts.resolveArtifact('datasets/old-snapshot/manifest.json'),
      ).resolves.toBeTruthy();
      const batches = await readdir(join(directory, 'artifacts', 'collection-batches')).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return [];
        },
      );
      expect(batches).toEqual([]);
      expect(await readdir(join(directory, 'job-workspaces'))).toEqual([]);
      expect(await datasets.getSnapshot(old.snapshot.id)).toEqual(oldSnapshot);
    },
  };
}

async function recoveryChild(
  f: Awaited<ReturnType<typeof fixture>>,
  taskId: string,
  runId: string,
  point = 'none',
  attempt = 1,
) {
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [
      '--experimental-transform-types',
      '--conditions=development',
      '--import',
      new URL('./fixtures/recovery-loader.mjs', import.meta.url).pathname,
      new URL('./fixtures/recovery-worker.ts', import.meta.url).pathname,
      f.directory,
      taskId,
      runId,
      point,
      String(attempt),
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
  let errorOutput = '';
  let lines = '';
  const seen = new Set<string>();
  const waiting = new Map<string, { resolve(): void; reject(error: Error): void }>();
  child.stderr.on('data', (value: Buffer) => {
    errorOutput = (errorOutput + value.toString()).slice(-16000);
  });
  child.stdout.on('data', (value: Buffer) => {
    lines += value.toString();
    let split: number;
    while ((split = lines.indexOf('\n')) >= 0) {
      const line = lines.slice(0, split);
      lines = lines.slice(split + 1);
      if (!line.startsWith('ZHIYUN_RECOVERY ')) continue;
      const message = JSON.parse(line.slice('ZHIYUN_RECOVERY '.length)) as {
        event: string;
        pid: number;
      };
      if (message.pid !== child.pid) {
        for (const waiter of waiting.values())
          waiter.reject(new Error('Recovery worker PID mismatch'));
        continue;
      }
      seen.add(message.event);
      waiting.get(message.event)?.resolve();
    }
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', (error) => {
        for (const waiter of waiting.values()) waiter.reject(error);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        for (const waiter of waiting.values())
          waiter.reject(
            new Error(`Recovery worker exited before its event: ${code}/${signal}. ${errorOutput}`),
          );
        resolve({ code, signal });
      });
    },
  );
  // Only this explicitly spawned child; cleanup is registered after the fixture resources.
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const wait = async (name: string) => {
    if (seen.has(name)) return;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Recovery worker is terminal. ${errorOutput}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(name);
        reject(new Error(`Recovery event timeout: ${name}. ${errorOutput}`));
      }, 20000);
      waiting.set(name, {
        resolve: () => {
          clearTimeout(timer);
          waiting.delete(name);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          waiting.delete(name);
          reject(error);
        },
      });
    });
  };
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

async function datasetRows(f: Awaited<ReturnType<typeof fixture>>, datasetId: string) {
  const result: Array<{ sourceUrl: string; data: Record<string, unknown> }> = [];
  let cursor: string | undefined;
  do {
    const page = await f.datasets.listRecords(datasetId, cursor, 500);
    result.push(...page.items.map(({ sourceUrl, data }) => ({ sourceUrl, data })));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return result.sort((left, right) =>
    String(left.data.id ?? left.sourceUrl).localeCompare(String(right.data.id ?? right.sourceUrl)),
  );
}

async function assertNoStoredMarker(directory: string, marker: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await assertNoStoredMarker(path, marker);
    else if (entry.isFile())
      expect((await readFile(path)).includes(Buffer.from(marker))).toBe(false);
    else throw new Error('Unexpected fixture filesystem entry');
  }
}

describe('production collection batches with real Artifact and SQLite persistence', () => {
  it('keeps a three-record sitemap preview while scanning modification order and only visits its selected details', async () => {
    const f = await fixture('sitemap', true);
    const result = await new CrawlerRuntime().crawl({
      url: f.task.startUrl,
      plan: f.definition,
      requestSettings: f.task.requestSettings,
      browserSettings: f.task.browserSettings,
      pagination: f.task.pagination,
      networkPolicy: f.task.networkPolicy,
      previewLimit: 3,
    });
    expect(result.records.map((row) => row.data.id)).toEqual(['2-257', '2-256', '2-255']);
    expect(f.detailsRequested).toHaveLength(3);
    expect(f.requestedPages).toEqual([0, 1, 2]);
    expect(result.metadata.requestCount).toBe(6);
  });

  it('streams sitemap discovery in bounded Artifact batches and preserves global sorting before the detail limit', async () => {
    const f = await fixture('sitemap', true, 300);
    const control = await new CrawlerRuntime().crawl({
      url: f.task.startUrl,
      plan: f.definition,
      requestSettings: f.task.requestSettings,
      browserSettings: f.task.browserSettings,
      pagination: f.task.pagination,
      networkPolicy: f.task.networkPolicy,
    });
    const expectedDetails = [...f.detailsRequested];
    expect(expectedDetails).toHaveLength(300);
    f.requestedPages.length = 0;
    f.detailsRequested.length = 0;
    const blocked = deferred();
    const release = deferred();
    const commit = f.artifacts.commitWorkspaceFile.bind(f.artifacts);
    let maxDiscoveryRows = 0;
    let first = true;
    vi.spyOn(f.artifacts, 'commitWorkspaceFile').mockImplementation(async (...args) => {
      if (args[2].includes('/discovery/')) {
        const workspace = await f.artifacts.openWorkspace(args[0]);
        const data = JSON.parse(await readFile(await workspace.resolve(args[1]), 'utf8')) as {
          entries: unknown[];
          nodes: unknown[];
        };
        maxDiscoveryRows = Math.max(maxDiscoveryRows, data.entries.length + data.nodes.length);
        if (first) {
          first = false;
          blocked.resolve();
          await release.promise;
        }
      }
      return commit(...args);
    });
    const running = f.execute();
    try {
      await blocked.promise;
      expect(f.requestedPages).toEqual([0]);
      expect(f.detailsRequested).toEqual([]);
      expect((await f.datasets.listRecords(f.old.dataset.id)).items[0]?.data.id).toBe('old');
    } finally {
      release.resolve();
    }
    await running;
    expect(f.requestedPages).toEqual([0, 1, 2]);
    expect(f.detailsRequested.sort()).toEqual(expectedDetails.sort());
    expect(f.emittedUrls).toEqual(control.records.map((record) => record.sourceUrl));
    expect(maxDiscoveryRows).toBe(250);
    expect(Math.max(...f.observedRows)).toBeLessThanOrEqual(250);
    const rows = (await datasetRows(f, f.old.dataset.id)).sort((a, b) =>
      a.sourceUrl.localeCompare(b.sourceUrl),
    );
    expect(rows).toEqual(
      control.records
        .map(({ sourceUrl, data }) => ({ sourceUrl, data }))
        .sort((a, b) => a.sourceUrl.localeCompare(b.sourceUrl)),
    );
    const run = (await f.collection.getRun(f.run.id))!;
    expect(run.recordCount).toBe(300);
    expect(run.requestCount).toBe(303);
    expect(run.metadata.warnings).toEqual(control.metadata.warnings);
    await f.assertClean();
  }, 60000);

  it('resumes a committed sitemap prefix after acknowledgement loss without losing nested links or refetching completed maps', async () => {
    const f = await fixture('sitemap');
    const stage = f.collection.stageSitemapBatch.bind(f.collection);
    let batches = 0;
    vi.spyOn(f.collection, 'stageSitemapBatch').mockImplementation(async (...args) => {
      await stage(...args);
      if (++batches === 3) throw new Error('fixture discovery acknowledgement lost');
    });
    await expect(f.execute()).rejects.toThrow('Crawl failed');
    expect(f.requestedPages).toEqual([0, 1]);
    await f.reopen();
    await f.execute(2);
    expect(f.requestedPages).toEqual([0, 1, 1, 2]);
    expect((await f.collection.getRun(f.run.id))?.recordCount).toBe(519);
    expect((await f.collection.getRun(f.run.id))?.requestCount).toBe(3);
    expect(await f.datasets.listSnapshots(f.old.dataset.id)).toHaveLength(2);
    await f.assertClean();
  });

  it('rejects a truncated replay of an unfinished sitemap instead of publishing its committed prefix', async () => {
    const f = await fixture('sitemap');
    const stage = f.collection.stageSitemapBatch.bind(f.collection);
    let batches = 0;
    vi.spyOn(f.collection, 'stageSitemapBatch').mockImplementation(async (...args) => {
      await stage(...args);
      if (++batches === 2) throw new Error('fixture discovery acknowledgement lost');
    });
    await expect(f.execute()).rejects.toThrow('Crawl failed');
    f.emptySitemap(1);
    await f.reopen();
    await expect(f.execute(2)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      retryable: false,
    });
    expect(f.requestedPages).toEqual([0, 1, 1]);
    expect((await f.datasets.listRecords(f.old.dataset.id)).items[0]?.data.id).toBe('old');
    expect(await f.datasets.listSnapshots(f.old.dataset.id)).toHaveLength(1);
    await f.assertClean();
  });

  it('finishes the interrupted sitemap at maxUrls without requesting a new map or counting the replay twice', async () => {
    const f = await fixture('sitemap');
    const active = (await f.collection.getActiveRule(f.task.id))!;
    await f.collection.createRuleVersion(
      f.task.id,
      active.rule.id,
      { ...f.definition, discovery: { ...f.definition.discovery!, maxUrls: 260 } },
      'human',
    );
    const stage = f.collection.stageSitemapBatch.bind(f.collection);
    let batches = 0;
    vi.spyOn(f.collection, 'stageSitemapBatch').mockImplementation(async (...args) => {
      await stage(...args);
      if (++batches === 3) throw new Error('fixture acknowledgement lost at maxUrls');
    });
    await expect(f.execute()).rejects.toThrow('Crawl failed');
    await f.reopen();
    await f.execute(2);
    expect(f.requestedPages).toEqual([0, 1, 1]);
    const run = (await f.collection.getRun(f.run.id))!;
    expect(run.recordCount).toBe(260);
    expect(run.requestCount).toBe(2);
    await f.assertClean();
  });

  it('does not charge unvisited nested maps or details after the sitemap request budget is exhausted', async () => {
    const f = await fixture('sitemap', true);
    expect(
      await f.collection.updateTask(
        f.task.id,
        { requestSettings: { ...f.task.requestSettings, maxRequests: 2 } },
        f.task.revision,
      ),
    ).not.toBeNull();
    await f.execute();
    expect(f.requestedPages).toEqual([0, 1]);
    expect(f.detailsRequested).toEqual([]);
    const run = (await f.collection.getRun(f.run.id))!;
    expect(run.recordCount).toBe(260);
    expect(run.requestCount).toBe(2);
    expect(run.metadata.warnings).toContain(
      'Sitemap discovery stopped because maxRequests was reached',
    );
    await f.assertClean();
  });

  it.each(['depth', 'maps'] as const)(
    'preserves sitemap %s limits and their stop reason',
    async (limit) => {
      const f = await fixture('sitemap');
      const definition = normalizeCrawlPlan({
        ...f.definition,
        discovery: {
          ...f.definition.discovery!,
          ...(limit === 'depth' ? { maxDepth: 0 } : { maxSitemaps: 1 }),
        },
      });
      const control = await new CrawlerRuntime().crawl({
        url: f.task.startUrl,
        plan: definition,
        requestSettings: f.task.requestSettings,
        browserSettings: f.task.browserSettings,
        pagination: f.task.pagination,
        networkPolicy: f.task.networkPolicy,
      });
      f.requestedPages.length = 0;
      const active = (await f.collection.getActiveRule(f.task.id))!;
      await f.collection.createRuleVersion(f.task.id, active.rule.id, definition, 'human');
      await f.execute();
      expect(f.requestedPages).toEqual([0]);
      const run = (await f.collection.getRun(f.run.id))!;
      expect(run.recordCount).toBe(0);
      expect(run.requestCount).toBe(1);
      expect(run.metadata.warnings).toEqual(control.metadata.warnings);
      await f.assertClean();
    },
  );

  it('rejects a damaged completed sitemap Artifact before projecting its indexed URLs', async () => {
    const f = await fixture('sitemap');
    const stage = f.datasets.stageBatch.bind(f.datasets);
    vi.spyOn(f.datasets, 'stageBatch').mockImplementationOnce(async (input) => {
      await stage(input);
      throw new Error('fixture final acknowledgement lost');
    });
    await expect(f.execute()).rejects.toThrow('Crawl failed');
    const directory = join(f.directory, 'artifacts', 'collection-batches', f.run.id, 'discovery');
    const [file] = await readdir(directory);
    expect(file).toBeTruthy();
    await writeFile(join(directory, file!), 'fixture-corrupted-json');
    await f.reopen();
    await expect(f.execute(2)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      retryable: false,
    });
    expect(f.requestedPages).toEqual([0, 1, 2]);
    expect((await f.datasets.listRecords(f.old.dataset.id)).items[0]?.data.id).toBe('old');
    expect(await f.datasets.listSnapshots(f.old.dataset.id)).toHaveLength(1);
    await f.assertClean();
  });

  it.each(
    (['http', 'sitemap'] as const).flatMap((mode) =>
      [
        'during_request',
        'after_artifact',
        'before_checkpoint',
        'after_checkpoint',
        'after_projection',
        ...(mode === 'sitemap' ? ['after_discovery_stage'] : []),
      ].map((point) => ({ mode, point })),
    ),
  )(
    'resumes an actual killed $mode process at $point with the same records and statistics as a control process',
    async ({ mode, point }) => {
      const f = await fixture(mode);
      const controlTask = await f.collection.createTask(
        taskCreateSchema.parse({ ...f.task, name: 'Control process' }),
      );
      await f.collection.createRule(controlTask.id, 'control', f.definition, 'human');
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
      await (await recoveryChild(f, controlTask.id, controlRun.id)).finish();
      const control = (await f.collection.getRun(controlRun.id))!;
      const expected = await datasetRows(f, controlOld.dataset.id);
      expect(control.status).toBe('succeeded');
      expect(f.requestedPages).toEqual(mode === 'sitemap' ? [0, 1, 2] : [1, 2, 3]);
      f.requestedPages.length = 0;
      const inFlight = point === 'during_request' ? f.holdPage(2) : null;
      const interrupted = await recoveryChild(f, f.task.id, f.run.id, point);
      if (inFlight) await inFlight;
      else await interrupted.wait('fault');
      expect((await f.collection.getRun(f.run.id))?.status).toBe('running');
      await interrupted.kill();
      if (point !== 'after_projection') {
        expect((await f.datasets.listRecords(f.old.dataset.id)).items[0]?.data.id).toBe('old');
        expect(await f.datasets.listSnapshots(f.old.dataset.id)).toHaveLength(1);
      } else expect(await f.datasets.listSnapshots(f.old.dataset.id)).toHaveLength(2);
      await (await recoveryChild(f, f.task.id, f.run.id, 'none', 2)).finish();
      const recovered = (await f.collection.getRun(f.run.id))!;
      expect(recovered.status).toBe('succeeded');
      expect(recovered.recordCount).toBe(control.recordCount);
      expect(recovered.requestCount).toBe(control.requestCount);
      expect(recovered.browserUsed).toBe(control.browserUsed);
      expect(recovered.datasetStats).toEqual(control.datasetStats);
      const rows = await datasetRows(f, f.old.dataset.id);
      expect(rows).toEqual(expected);
      expect(new Set(rows.map((row) => row.data.id ?? row.sourceUrl)).size).toBe(
        mode === 'sitemap' ? 519 : 778,
      );
      expect(await f.datasets.listSnapshots(f.old.dataset.id)).toHaveLength(2);
      expect(f.requestedPages).toEqual(
        mode === 'sitemap'
          ? ['after_checkpoint', 'after_projection'].includes(point)
            ? [0, 1, 2]
            : point === 'during_request'
              ? [0, 1, 2, 2]
              : [0, 1, 1, 2]
          : ['after_checkpoint', 'after_projection'].includes(point)
            ? [1, 2, 3]
            : [1, 2, 2, 3],
      );
      await f.assertClean();
    },
    60000,
  );

  it.each(['html', 'browser'] as const)(
    'restores %s next-link pagination after the completed page checkpoint loses its acknowledgement',
    async (mode) => {
      const f = await fixture(mode);
      const active = (await f.collection.getActiveRule(f.task.id))!;
      await f.collection.createRuleVersion(
        f.task.id,
        active.rule.id,
        { ...f.definition, pagination: { type: 'next', selector: 'a.next', maxPages: 3 } },
        'human',
      );
      const complete = f.collection.completeCrawlRequest.bind(f.collection);
      vi.spyOn(f.collection, 'completeCrawlRequest').mockImplementationOnce(async (...args) => {
        await complete(...args);
        throw new Error('fixture checkpoint acknowledgement lost');
      });
      await expect(f.execute()).rejects.toThrow('Crawl failed');
      expect(f.requestedPages).toEqual([1]);
      await f.reopen();
      await f.execute(2);
      expect(f.requestedPages).toEqual([1, 2, 3]);
      const run = (await f.collection.getRun(f.run.id))!;
      expect(run.recordCount).toBe(778);
      expect(run.requestCount).toBe(3);
      expect(run.browserUsed).toBe(mode === 'browser');
      await f.assertClean();
    },
    60000,
  );

  it.each(['html', 'browser'] as const)(
    'restores authenticated %s requests without storing secret headers in its checkpoint files',
    async (mode) => {
      const f = await fixture(mode);
      const authorization = 'Bearer fixture-checkpoint-secret-header-78342';
      f.requireAuthorization(authorization);
      const active = (await f.collection.getActiveRule(f.task.id))!;
      await f.collection.createRuleVersion(
        f.task.id,
        active.rule.id,
        { ...f.definition, pagination: { type: 'next', selector: 'a.next', maxPages: 3 } },
        'human',
      );
      vi.spyOn(f.credentialStore, 'resolve').mockImplementation(
        async <T>() => ({ authorization }) as T,
      );
      expect(
        await f.collection.updateTask(
          f.task.id,
          { credentialBindings: { secretHeadersRef: 'fixture-headers' } },
          f.task.revision,
        ),
      ).not.toBeNull();
      const complete = f.collection.completeCrawlRequest.bind(f.collection);
      vi.spyOn(f.collection, 'completeCrawlRequest').mockImplementationOnce(async (...args) => {
        await complete(...args);
        throw new Error('fixture checkpoint acknowledgement lost');
      });
      await expect(f.execute()).rejects.toThrow('Crawl failed');
      expect(f.requestedPages).toEqual([1]);
      await assertNoStoredMarker(f.directory, authorization);
      await f.reopen();
      await f.execute(2);
      expect(f.requestedPages).toEqual([1, 2, 3]);
      expect((await f.collection.getRun(f.run.id))?.recordCount).toBe(778);
      await assertNoStoredMarker(f.directory, authorization);
      await f.assertClean();
    },
    60000,
  );

  it('rejects retained URL checkpoints after credential material changes', async () => {
    const f = await fixture('html');
    let authorization = 'Bearer fixture-credential-before-rotation';
    f.requireAuthorization(authorization);
    const active = (await f.collection.getActiveRule(f.task.id))!;
    await f.collection.createRuleVersion(
      f.task.id,
      active.rule.id,
      { ...f.definition, pagination: { type: 'next', selector: 'a.next', maxPages: 3 } },
      'human',
    );
    vi.spyOn(f.credentialStore, 'resolve').mockImplementation(
      async <T>() => ({ authorization }) as T,
    );
    expect(
      await f.collection.updateTask(
        f.task.id,
        { credentialBindings: { secretHeadersRef: 'fixture-headers' } },
        f.task.revision,
      ),
    ).not.toBeNull();
    const complete = f.collection.completeCrawlRequest.bind(f.collection);
    vi.spyOn(f.collection, 'completeCrawlRequest').mockImplementationOnce(async (...args) => {
      await complete(...args);
      throw new Error('fixture checkpoint acknowledgement lost');
    });
    await expect(f.execute()).rejects.toThrow('Crawl failed');
    await f.reopen();
    authorization = 'Bearer fixture-credential-after-rotation';
    f.requireAuthorization(authorization);
    await expect(f.execute(2)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      retryable: false,
    });
    expect(f.requestedPages).toEqual([1]);
    expect((await f.datasets.listRecords(f.old.dataset.id)).items[0]?.data.id).toBe('old');
    expect(await f.datasets.listSnapshots(f.old.dataset.id)).toHaveLength(1);
    await f.assertClean();
  });

  it('restores detail request counts and a cached failure after a staged batch acknowledgement is lost', async () => {
    const f = await fixture('http', true);
    f.failDetail('1-0');
    const active = (await f.collection.getActiveRule(f.task.id))!;
    await f.collection.createRuleVersion(
      f.task.id,
      active.rule.id,
      { ...f.definition, detail: { ...f.definition.detail!, onError: 'keep-list-record' } },
      'human',
    );
    const stage = f.datasets.stageBatch.bind(f.datasets);
    vi.spyOn(f.datasets, 'stageBatch').mockImplementationOnce(async (input) => {
      await stage(input);
      throw new Error('fixture staged acknowledgement lost');
    });
    await expect(f.execute()).rejects.toThrow('Crawl failed');
    f.failDetail(null);
    await f.reopen();
    await f.execute(2);
    const run = (await f.collection.getRun(f.run.id))!;
    expect(run.recordCount).toBe(778);
    expect(run.requestCount).toBe(781);
    expect(f.requestedPages).toEqual([1, 2, 3]);
    expect(f.detailsRequested).toHaveLength(778);
    expect(f.detailsRequested.filter((id) => id === '1-0')).toHaveLength(1);
    const rows = await datasetRows(f, f.old.dataset.id);
    expect(rows.find((row) => row.data.id === '1-0')?.data.description).toBeUndefined();
    expect(rows.find((row) => row.data.id === '3-0')?.data.description).toBe('detail-3-0');
    await f.assertClean();
  }, 60000);

  it('shares a durable request budget between list pages and details', async () => {
    const f = await fixture('http', true);
    await f.collection.updateTask(
      f.task.id,
      { requestSettings: { ...f.task.requestSettings, maxRequests: 4 } },
      f.task.revision,
    );
    await f.execute();
    expect((await f.collection.getRun(f.run.id))?.requestCount).toBe(4);
    expect(f.requestedPages).toEqual([1, 2, 3]);
    expect(f.detailsRequested).toHaveLength(1);
    expect((await f.collection.getRun(f.run.id))?.recordCount).toBe(778);
    await f.assertClean();
  });

  it.each(['http', 'browser'] as const)(
    'waits for slow %s list persistence and keeps the old Snapshot until projection',
    async (mode) => {
      const f = await fixture(mode);
      const entered = deferred();
      const gate = deferred();
      const commit = f.artifacts.commitWorkspaceFile.bind(f.artifacts);
      let first = true;
      vi.spyOn(f.artifacts, 'commitWorkspaceFile').mockImplementation(async (...args) => {
        if (first && args[2].includes('/list/')) {
          first = false;
          entered.resolve();
          await gate.promise;
        }
        return commit(...args);
      });
      const running = f.execute();
      try {
        await entered.promise;
        await new Promise<void>((done) => setTimeout(done, 30));
        expect(f.requestedPages).toEqual([1]);
        expect(f.persisting).not.toHaveBeenCalled();
        expect((await f.datasets.listRecords(f.old.dataset.id)).items[0]?.data.id).toBe('old');
      } finally {
        gate.resolve();
      }
      await running;
      const run = (await f.collection.getRun(f.run.id))!;
      expect(run.status).toBe('succeeded');
      expect(run.recordCount).toBe(778);
      expect(run.datasetStats).toEqual({
        added: 778,
        updated: 0,
        removed: 1,
        unchanged: 0,
        current: 778,
      });
      expect(run.browserUsed).toBe(mode === 'browser');
      expect(run.requestCount).toBe(3);
      expect(Math.max(...f.observedRows)).toBe(250);
      expect(f.observedRows).toHaveLength(6);
      expect(await f.datasets.listSnapshots(f.old.dataset.id)).toHaveLength(2);
      await f.assertClean();
    },
    60000,
  );

  it('preserves the pre-detail limit and performs unique detail requests across more than 500 cached URLs', async () => {
    const f = await fixture('http', true);
    await f.execute();
    const run = (await f.collection.getRun(f.run.id))!;
    expect(run.recordCount).toBe(778);
    expect(run.requestCount).toBe(781);
    expect(f.detailsRequested).toHaveLength(778);
    expect(f.detailsRequested.filter((id) => id === 'common')).toHaveLength(1);
    const record = await f.datasets.listRecords(f.old.dataset.id, undefined, 500, {
      filters: [{ field: 'id', operator: 'eq', value: 'common' }],
    });
    expect(record.items[0]?.data.description).toBe('detail-common');
    await f.assertClean();
  }, 60000);

  it('limits raw list rows before durable deduplication', async () => {
    const f = await fixture('http', false, 520);
    await f.execute();
    expect((await f.collection.getRun(f.run.id))?.recordCount).toBe(519);
    expect((await f.datasets.getDataset(f.old.dataset.id))?.currentCount).toBe(519);
    expect(f.observedRows).toHaveLength(4);
    await f.assertClean();
  });

  it('replays an acknowledgement lost after the Dataset transaction across closed/reopened repositories', async () => {
    const f = await fixture();
    const stage = f.datasets.stageBatch.bind(f.datasets);
    let first = true;
    vi.spyOn(f.datasets, 'stageBatch').mockImplementation(async (input) => {
      const committed = await stage(input);
      if (first) {
        first = false;
        throw new Error('fixture acknowledgement lost after commit');
      }
      return committed;
    });
    await expect(f.execute()).rejects.toThrow('Crawl failed');
    expect(first).toBe(false);
    expect(await f.collection.getRun(f.run.id)).toMatchObject({
      status: 'queued',
      phase: 'retrying',
      finishedAt: null,
    });
    expect((await f.datasets.listRecords(f.old.dataset.id)).items[0]?.data.id).toBe('old');
    expect(await f.datasets.listSnapshots(f.old.dataset.id)).toHaveLength(1);
    expect(await readdir(join(f.directory, 'artifacts', 'collection-batches', f.run.id))).toContain(
      'list',
    );
    await f.reopen();
    await f.execute(2);
    expect(f.requestedPages).toEqual([1, 2, 3]);
    const run = (await f.collection.getRun(f.run.id))!;
    expect(run.status).toBe('succeeded');
    expect(run.recordCount).toBe(778);
    expect(run.datasetStats).toEqual({
      added: 778,
      updated: 0,
      removed: 1,
      unchanged: 0,
      current: 778,
    });
    expect(await f.datasets.listSnapshots(f.old.dataset.id)).toHaveLength(2);
    expect((await f.datasets.listRunRecords(f.run.id, undefined, 500)).items).toHaveLength(500);
    await f.assertClean();
  });

  it('cancels a blocked final Artifact write, preserves prior data, and removes its orphan files', async () => {
    const f = await fixture();
    const entered = deferred();
    const gate = deferred();
    const controller = new AbortController();
    const commit = f.artifacts.commitWorkspaceFile.bind(f.artifacts);
    let first = true;
    vi.spyOn(f.artifacts, 'commitWorkspaceFile').mockImplementation(async (...args) => {
      if (first && !args[2].includes('/list/')) {
        first = false;
        entered.resolve();
        await gate.promise;
      }
      return commit(...args);
    });
    const running = f.execute(1, controller.signal);
    try {
      await entered.promise;
      controller.abort();
    } finally {
      gate.resolve();
    }
    await expect(running).rejects.toThrow('canceled');
    expect((await f.collection.getRun(f.run.id))?.status).toBe('canceled');
    expect((await f.datasets.listRecords(f.old.dataset.id)).items[0]?.data.id).toBe('old');
    expect(await f.datasets.listSnapshots(f.old.dataset.id)).toHaveLength(1);
    await f.assertClean();
  });

  it('cleans retained batches after the owning task is deleted before a retry', async () => {
    const f = await fixture();
    const stage = f.datasets.stageBatch.bind(f.datasets);
    vi.spyOn(f.datasets, 'stageBatch').mockImplementationOnce(async (input) => {
      await stage(input);
      throw new Error('fixture acknowledgement lost after commit');
    });
    await expect(f.execute()).rejects.toThrow('Crawl failed');
    expect(await readdir(join(f.directory, 'artifacts', 'collection-batches', f.run.id))).toContain(
      'list',
    );
    expect(await f.collection.deleteTask(f.task.id)).toBe(true);
    expect(await f.collection.getRun(f.run.id)).toBeNull();
    await expect(f.execute(2)).rejects.toThrow('unavailable');
    await f.assertClean();
    expect((await f.datasets.listRecords(f.old.dataset.id)).items[0]?.data.id).toBe('old');
    // A different fingerprint may begin only once the retained ingestion is gone.
    await expect(
      f.datasets.beginIngestion({
        sourceTaskId: f.task.id,
        sourceRunId: f.run.id,
        fingerprint: 'a'.repeat(64),
        settings: f.task.datasetSettings,
        dedupe: f.definition.dedupe,
      }),
    ).resolves.toEqual({ acceptedCount: 0, committed: false });
    await f.datasets.discardIngestion(f.run.id);
  });

  it('preserves a real run when a retry payload names a different task', async () => {
    const f = await fixture();
    const stage = f.datasets.stageBatch.bind(f.datasets);
    vi.spyOn(f.datasets, 'stageBatch').mockImplementationOnce(async (input) => {
      await stage(input);
      throw new Error('fixture acknowledgement lost after commit');
    });
    await expect(f.execute()).rejects.toThrow('Crawl failed');
    await expect(
      f.execute(2, new AbortController().signal, { taskId: randomUUID(), runId: f.run.id }),
    ).rejects.toThrow('unavailable');
    expect(await readdir(join(f.directory, 'artifacts', 'collection-batches', f.run.id))).toContain(
      'list',
    );
    expect(await f.collection.getRun(f.run.id)).toMatchObject({
      status: 'queued',
      phase: 'retrying',
      finishedAt: null,
    });
    await f.execute(2);
    expect((await f.collection.getRun(f.run.id))?.recordCount).toBe(778);
    expect(await f.datasets.listSnapshots(f.old.dataset.id)).toHaveLength(2);
    await f.assertClean();
  });

  it.each(['rule', 'request settings'] as const)(
    'rejects retained batches after changing %s, without fetching new pages',
    async (change) => {
      const f = await fixture();
      const stage = f.datasets.stageBatch.bind(f.datasets);
      vi.spyOn(f.datasets, 'stageBatch').mockImplementationOnce(async (input) => {
        await stage(input);
        throw new Error('fixture acknowledgement lost after commit');
      });
      await expect(f.execute()).rejects.toThrow('Crawl failed');
      const requested = [...f.requestedPages];
      if (change === 'rule') {
        const active = (await f.collection.getActiveRule(f.task.id))!;
        expect(
          await f.collection.createRuleVersion(
            f.task.id,
            active.rule.id,
            { ...f.definition, limits: { maxRecords: 800 } },
            'human',
          ),
        ).not.toBeNull();
      } else {
        expect(
          await f.collection.updateTask(
            f.task.id,
            { requestSettings: { ...f.task.requestSettings, delayMs: 1 } },
            f.task.revision,
          ),
        ).not.toBeNull();
      }
      await expect(f.execute(2)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        retryable: false,
      });
      expect(f.requestedPages).toEqual(requested);
      expect((await f.datasets.listRecords(f.old.dataset.id)).items[0]?.data.id).toBe('old');
      expect(await f.datasets.listSnapshots(f.old.dataset.id)).toHaveLength(1);
      await f.assertClean();
    },
  );
});
