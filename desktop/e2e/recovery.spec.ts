import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import type { CrawlRun, RuntimeBootstrap } from '@zhiyun/contracts';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { testEnvironment } from '../../tooling/scripts/test-environment.js';
import { CollectionBrowserMemory } from '../tooling/e2e/process-memory.js';

const runFile = promisify(execFile);
type OwnedProcess = { pid: number; identity: string };
type CollectedRecord = { sourceUrl: string; data: Record<string, unknown> };

async function identity(pid: number): Promise<string | null> {
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
      const value = await identity(item.pid);
      if (value) owned.push({ pid: item.pid, identity: value });
    }
  }
}

async function reclaim(owned: OwnedProcess[]): Promise<void> {
  // Register ancestry before the crash; do not infer ownership from a process name.
  for (const item of [...owned].reverse()) {
    if ((await identity(item.pid)) !== item.identity) continue;
    try {
      process.kill(item.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  await expect
    .poll(
      async () => {
        for (const item of owned) {
          if ((await identity(item.pid)) === item.identity) return false;
        }
        return true;
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

async function request<T>(page: Page, path: string, body?: unknown): Promise<T> {
  // Nonces and generated local tokens never leave the Renderer closure or enter evidence.
  return page.evaluate(
    async ({ path, body, key }) => {
      const bridge = (
        window as typeof window & {
          zhiyunRuntime: { getBootstrap(): Promise<RuntimeBootstrap> };
        }
      ).zhiyunRuntime;
      const bootstrap = await bridge.getBootstrap();
      const session = await fetch(`${bootstrap.baseUrl}/api/v2/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce: bootstrap.sessionNonce }),
      });
      if (!session.ok) throw new Error(`Session HTTP ${session.status}`);
      const { token } = (await session.json()) as { token: string };
      const response = await fetch(`${bootstrap.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(result)}`);
      return result;
    },
    { path, body, key: randomUUID() },
  ) as Promise<T>;
}

async function fixture() {
  let seed = true;
  let hold = false;
  let held: ServerResponse | undefined;
  let onHeld: (() => void) | undefined;
  const requests: number[] = [];
  function sendItems(page: number, response: ServerResponse) {
    response.setHeader('content-type', 'application/json');
    response.write('{"items":[');
    for (let index = 0; index < (seed ? 1 : 260); index++) {
      const id = seed ? 'old' : index === 0 ? 'common' : `${page}-${index}`;
      response.write(
        `${index ? ',' : ''}${JSON.stringify({ id, payload: `${id}-${'x'.repeat(1000)}` })}`,
      );
    }
    response.end(']}');
  }
  const server = createServer((incoming, response) => {
    const url = new URL(incoming.url ?? '/', 'http://fixture');
    if (url.pathname === '/items') {
      const page = Number(url.searchParams.get('page'));
      requests.push(page);
      if (hold && page === 2) {
        hold = false;
        held = response;
        onHeld?.();
        return;
      }
      sendItems(page, response);
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><html><body><main></main><button id="more">More</button><script>
      let page = 0, busy = false;
      async function load() {
        if (busy || page >= 3) return;
        busy = true;
        const data = await fetch('/items?page=' + (++page)).then(r => r.json());
        for (const item of data.items) {
          const article = document.createElement('article'); article.dataset.id = item.id;
          const p = document.createElement('p'); p.textContent = item.payload; article.append(p);
          document.querySelector('main').append(article);
        }
        if (page === 3) document.querySelector('#more').hidden = true;
        busy = false;
      }
      document.querySelector('#more').addEventListener('click', load); void load();
    </script></body></html>`);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local fixture failed to bind');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    setSeed(value: boolean) {
      seed = value;
    },
    holdNextPage() {
      hold = true;
      return new Promise<void>((done) => {
        onHeld = done;
      });
    },
    release(deliver = false) {
      if (held && deliver) sendItems(2, held);
      else held?.destroy();
      held = undefined;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

async function launch(directory: string, afterReady?: (app: ElectronApplication) => Promise<void>) {
  const desktopRoot = resolve(import.meta.dirname, '..');
  const app = await electron.launch({
    args: [desktopRoot, `--user-data-dir=${directory}`],
    cwd: desktopRoot,
    env: { ...testEnvironment(process.env), TMPDIR: directory, TMP: directory, TEMP: directory },
  });
  const pid = app.process().pid!;
  const rootIdentity = await identity(pid);
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('heading', { name: '首页', exact: true })).toBeVisible();
    await afterReady?.(app);
    return { app, page };
  } catch (error) {
    const registered = await descendants(pid);
    if (rootIdentity) registered.unshift({ pid, identity: rootIdentity });
    await app.close().catch(() => undefined);
    await reclaim(registered);
    throw error;
  }
}

function inspect(directory: string, runId: string) {
  const database = new DatabaseSync(join(directory, 'zhiyun.sqlite3'), { readOnly: true });
  try {
    return {
      job: database
        .prepare('SELECT state,attempt,lease_owner,lease_expires_at FROM platform_jobs WHERE id=?')
        .get(runId),
      batches: database
        .prepare(
          'SELECT COUNT(*) AS count,SUM(row_count) AS rows FROM collection_crawl_batches WHERE run_id=?',
        )
        .get(runId),
      rounds: database
        .prepare(
          'SELECT round,status FROM collection_crawl_browser_rounds WHERE run_id=? ORDER BY round',
        )
        .all(runId),
      session: database
        .prepare(
          'SELECT request_count,raw_record_count FROM collection_crawl_sessions WHERE run_id=?',
        )
        .get(runId),
      workspaceRows: database
        .prepare('SELECT COUNT(*) AS count FROM collection_crawl_cleanup WHERE run_id=?')
        .get(runId),
    };
  } finally {
    database.close();
  }
}

async function createTask(page: Page, origin: string) {
  const task = await request<{ id: string }>(page, '/api/v2/tasks', {
    name: 'Owned host recovery fixture',
    startUrl: `${origin}/`,
    instruction: 'Local fixture',
    browserSettings: { enabled: true, actions: [{ type: 'waitFor', selector: 'article' }] },
    networkPolicy: { allowPrivateNetworks: true },
    requestSettings: {
      concurrency: 1,
      retries: 0,
      delayMs: 0,
      respectRobotsTxt: false,
      maxRequests: 1,
      timeoutMs: 60_000,
    },
    datasetSettings: { mode: 'snapshot', keyFields: ['id'], detectRemoved: true },
  });
  await request(page, `/api/v2/tasks/${task.id}/rules`, {
    name: 'Local list',
    generatedBy: 'human',
    definition: {
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
            payload: { selector: 'p', dataType: 'string' },
          },
        },
      },
      pagination: { type: 'loadMore', selector: '#more', maxClicks: 5, waitMs: 5000 },
      dedupe: { strategy: 'fields', fields: ['id'] },
      limits: { maxRecords: 1000 },
    },
  });
  return task.id;
}

async function startRun(page: Page, taskId: string) {
  return (await request<{ runId: string }>(page, `/api/v2/tasks/${taskId}/runs`, {})).runId;
}
async function completed(page: Page, runId: string) {
  let run: CrawlRun | undefined;
  await expect
    .poll(
      async () => {
        run = await request<CrawlRun>(page, `/api/v2/runs/${runId}`);
        if (['failed', 'canceled'].includes(run.status))
          throw new Error(`Run ${run.status}: ${run.error}`);
        return run.status;
      },
      { timeout: 75_000, intervals: [250, 500, 1000] },
    )
    .toBe('succeeded');
  return run!;
}
async function records(page: Page, runId: string) {
  const result: CollectedRecord[] = [];
  let cursor: string | null = null;
  do {
    const batch: { items: CollectedRecord[]; nextCursor: string | null } = await request(
      page,
      `/api/v2/runs/${runId}/records?limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    result.push(...batch.items.map(({ sourceUrl, data }) => ({ sourceUrl, data })));
    cursor = batch.nextCursor;
  } while (cursor);
  return result.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
async function runtimeProcess(app: ElectronApplication) {
  return app.evaluate(({ app }) => {
    const runtime = app
      .getAppMetrics()
      .find(
        (metric) => metric.name === 'ZhiYun Runtime' || metric.serviceName === 'ZhiYun Runtime',
      );
    if (!runtime) throw new Error('Production utility process is not present');
    return { pid: runtime.pid, creationTime: runtime.creationTime };
  });
}

for (const fault of ['utility', 'main', 'renderer'] as const) {
  test(`same collection survives a real Electron ${fault} crash`, async ({ browserName }, info) => {
    void browserName;
    test.setTimeout(180_000);
    test.skip(process.platform === 'win32', 'Owned-process verification uses macOS/Linux ps');
    const directory = await mkdtemp(join(tmpdir(), 'zhiyun-host-recovery-'));
    await writeFile(
      join(directory, 'test-owner.json'),
      JSON.stringify({
        fixture: 'zhiyun-host-recovery-e2e',
        workspace: resolve(import.meta.dirname, '../..'),
        title: info.title,
        parentPid: process.pid,
        createdAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    const source = await fixture();
    let host: Awaited<ReturnType<typeof launch>> | undefined;
    let memory: CollectionBrowserMemory | undefined;
    const owned: OwnedProcess[] = [];
    try {
      host = await launch(directory);
      const rootIdentity = await identity(host.app.process().pid!);
      if (!rootIdentity) throw new Error('Owned Electron main process is not live');
      owned.push({ pid: host.app.process().pid!, identity: rootIdentity });
      const controlTask = await createTask(host.page, source.origin);
      const controlSeed = await completed(host.page, await startRun(host.page, controlTask));
      expect(controlSeed.recordCount).toBe(1);
      source.setSeed(false);
      const control = await completed(host.page, await startRun(host.page, controlTask));
      const controlRecords = await records(host.page, control.id);
      expect(controlRecords).toHaveLength(778);
      expect(new Set(controlRecords.map((item) => item.data.id)).size).toBe(778);

      source.setSeed(true);
      const taskId = await createTask(host.page, source.origin);
      const seed = await completed(host.page, await startRun(host.page, taskId));
      const datasetId = seed.metadata.datasetId as string;
      const snapshotId = seed.metadata.datasetSnapshotId as string;
      const oldSnapshot = await request(
        host.page,
        `/api/v2/datasets/${datasetId}/snapshots/${snapshotId}`,
      );
      const oldRecords = await records(host.page, seed.id);
      source.setSeed(false);
      memory = new CollectionBrowserMemory(host.app.process().pid!);
      const blocked = source.holdNextPage();
      const runId = await startRun(host.page, taskId);
      await blocked;
      const before = inspect(directory, runId);
      expect(before.job).toMatchObject({ state: 'running', attempt: 1 });
      expect(before.batches).toEqual({ count: 2, rows: 260 });
      expect(before.rounds).toEqual([{ round: 0, status: 'completed' }]);
      expect(before.session).toEqual({ request_count: 1, raw_record_count: 260 });
      expect(
        await request(host.page, `/api/v2/datasets/${datasetId}/snapshots/${snapshotId}`),
      ).toEqual(oldSnapshot);
      expect(await records(host.page, seed.id)).toEqual(oldRecords);
      const previousRuntime = await runtimeProcess(host.app);
      const previousMain = host.app.process().pid!;
      owned.push(...(await descendants(previousMain)));
      const captured = Date.now();
      await writeFile(
        info.outputPath('before-crash.json'),
        `${JSON.stringify({ fault, before, previousRuntime, previousMain }, null, 2)}\n`,
      );
      if (fault === 'main') {
        const process = host.app.process();
        const exited = new Promise<void>((done) => process.once('exit', () => done()));
        expect(process.kill('SIGKILL')).toBe(true);
        await exited;
        await expect.poll(() => identity(previousRuntime.pid), { timeout: 5000 }).toBeNull();
        await reclaim(owned);
        source.release();
        host = await launch(directory);
        const nextIdentity = await identity(host.app.process().pid!);
        if (!nextIdentity) throw new Error('Restarted owned Electron main is not live');
        owned.push({ pid: host.app.process().pid!, identity: nextIdentity });
        memory.setRoot(host.app.process().pid!);
        expect(host.app.process().pid).not.toBe(previousMain);
      } else if (fault === 'utility') {
        const registered = owned.find((item) => item.pid === previousRuntime.pid);
        expect(registered).toBeDefined();
        expect(await identity(previousRuntime.pid)).toBe(registered!.identity);
        process.kill(previousRuntime.pid, 'SIGKILL');
        source.release();
        await expect
          .poll(
            async () => {
              try {
                return (await runtimeProcess(host!.app)).pid;
              } catch {
                return previousRuntime.pid;
              }
            },
            { timeout: 20_000 },
          )
          .not.toBe(previousRuntime.pid);
        // Wait for the new Runtime to finish bootstrap, using only the normal bridge.
        await expect
          .poll(async () => {
            try {
              await request(host!.page, '/api/v2/runtime');
              return true;
            } catch {
              return false;
            }
          })
          .toBe(true);
      } else {
        await host.page.goto(`app://zhiyun/runs/${runId}`);
        const replacement = host.app.waitForEvent('window');
        const rendererPid = await host.app.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0]!;
          const pid = window.webContents.getOSProcessId();
          window.webContents.forcefullyCrashRenderer();
          return pid;
        });
        source.release(true);
        host.page = await replacement;
        await host.page.waitForLoadState('domcontentloaded');
        await expect
          .poll(
            () =>
              host!.app.evaluate(({ BrowserWindow }) =>
                BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId(),
              ),
            { timeout: 20_000 },
          )
          .not.toBe(rendererPid);
        await expect(
          host.page.getByRole('heading', { name: '采集运行', exact: true }),
        ).toBeVisible();
        expect(host.page.url()).toBe(`app://zhiyun/runs/${runId}`);
        expect(await runtimeProcess(host.app)).toEqual(previousRuntime);
      }
      const resumed = await completed(host.page, runId);
      expect(resumed.recordCount).toBe(control.recordCount);
      expect(resumed.requestCount).toBe(control.requestCount);
      expect(resumed.datasetStats).toEqual(control.datasetStats);
      expect(resumed.browserUsed).toBe(true);
      expect(resumed.aiUsed).toBe(false);
      expect(await records(host.page, runId)).toEqual(controlRecords);
      expect(await records(host.page, seed.id)).toEqual(oldRecords);
      expect(
        await request(host.page, `/api/v2/datasets/${datasetId}/snapshots/${snapshotId}`),
      ).toEqual(oldSnapshot);
      const snapshots = await request<Array<{ sourceRunId: string }>>(
        host.page,
        `/api/v2/datasets/${datasetId}/snapshots`,
      );
      expect(snapshots).toHaveLength(2);
      expect(snapshots.filter((item) => item.sourceRunId === runId)).toHaveLength(1);
      await expect
        .poll(() => inspect(directory, runId).job)
        .toMatchObject({ state: 'succeeded', attempt: fault === 'renderer' ? 1 : 2 });
      await expect.poll(() => inspect(directory, runId).session).toBeUndefined();
      await expect.poll(() => inspect(directory, runId).workspaceRows).toEqual({ count: 0 });
      const browserMemory = await memory.stop();
      memory = undefined;
      await writeFile(
        info.outputPath('recovery.json'),
        `${JSON.stringify(
          {
            fault,
            before,
            after: inspect(directory, runId),
            elapsedAfterCrashMs: Date.now() - captured,
            recordCount: resumed.recordCount,
            requestCount: resumed.requestCount,
            stats: resumed.datasetStats,
            sourceRequests: source.requests,
            oldSnapshotUnchanged: true,
            recordsEqualToUninterrupted: true,
            mainPidChanged: host.app.process().pid !== previousMain,
            runtimePidChanged: (await runtimeProcess(host.app)).pid !== previousRuntime.pid,
            browserMemory,
          },
          null,
          2,
        )}\n`,
      );
      if (fault === 'renderer') {
        // Exercise the three-restarts/ten-minutes guard with real Renderer crashes.
        // Intercept only the final native error dialog, so it cannot block the test.
        await host.app.evaluate(({ dialog }) => {
          const state = globalThis as typeof globalThis & { recoveryDialogs: string[] };
          state.recoveryDialogs = [];
          dialog.showErrorBox = (title, content) =>
            state.recoveryDialogs.push(`${title}: ${content}`);
        });
        for (let index = 0; index < 2; index++) {
          await host.app.evaluate(({ BrowserWindow }, index) => {
            const window = BrowserWindow.getAllWindows()[0]!;
            if (index === 0) {
              window.setBounds({ x: 40, y: 40, width: 1100, height: 800 });
              window.hide();
            } else {
              window.show();
              window.maximize();
            }
          }, index);
          if (index === 1) {
            await expect
              .poll(() =>
                host!.app.evaluate(({ BrowserWindow }) =>
                  BrowserWindow.getAllWindows()[0]!.isMaximized(),
                ),
              )
              .toBe(true);
          }
          const previousState = await host.app.evaluate(({ BrowserWindow }) => {
            const window = BrowserWindow.getAllWindows()[0]!;
            return {
              bounds: window.getNormalBounds(),
              visible: window.isVisible(),
              maximized: window.isMaximized(),
            };
          });
          const replacement = host.app.waitForEvent('window');
          await host.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer(),
          );
          host.page = await replacement;
          await expect(
            host.page.getByRole('heading', { name: '采集运行', exact: true }),
          ).toBeVisible();
          expect(host.page.url()).toBe(`app://zhiyun/runs/${runId}`);
          await expect
            .poll(() =>
              host!.app.evaluate(({ BrowserWindow }) => {
                const window = BrowserWindow.getAllWindows()[0]!;
                return {
                  bounds: window.getNormalBounds(),
                  visible: window.isVisible(),
                  maximized: window.isMaximized(),
                };
              }),
            )
            .toEqual(previousState);
        }
        const finalWindowId = await host.app.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0]!;
          const id = window.id;
          window.webContents.forcefullyCrashRenderer();
          return id;
        });
        await expect
          .poll(() =>
            host!.app.evaluate(
              () =>
                (globalThis as typeof globalThis & { recoveryDialogs: string[] }).recoveryDialogs
                  .length,
            ),
          )
          .toBe(1);
        const exhausted = await host.app.evaluate(async ({ BrowserWindow }) => {
          await new Promise<void>((done) => setTimeout(done, 1000));
          return BrowserWindow.getAllWindows().map((window) => window.id);
        });
        expect(exhausted).toEqual([finalWindowId]);
        expect(await runtimeProcess(host.app)).toEqual(previousRuntime);
        expect(inspect(directory, runId).job).toMatchObject({ state: 'succeeded', attempt: 1 });
        await writeFile(
          info.outputPath('renderer-limit.json'),
          `${JSON.stringify({ successfulAutomaticRestarts: 3, finalDialogCount: 1, stoppedAfterFourthCrash: true, runtimeUnchanged: true }, null, 2)}\n`,
        );
      }
    } finally {
      await memory?.stop().catch(() => undefined);
      if (host) {
        owned.push(...(await descendants(host.app.process().pid!).catch(() => [])));
        await host.app.close().catch(() => undefined);
      }
      await reclaim(owned);
      await source.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('launch cleanup owns processes when startup assertions fail', async ({ browserName }) => {
  void browserName;
  test.skip(process.platform === 'win32', 'Owned-process verification uses macOS/Linux ps');
  const directory = await mkdtemp(join(tmpdir(), 'zhiyun-host-recovery-'));
  const registered: OwnedProcess[] = [];
  try {
    await expect(
      launch(directory, async (app) => {
        const pid = app.process().pid!;
        const value = await identity(pid);
        if (!value) throw new Error('Owned main process did not start');
        registered.push({ pid, identity: value }, ...(await descendants(pid)));
        throw new Error('Injected assertion failure after actual host startup');
      }),
    ).rejects.toThrow('Injected assertion failure after actual host startup');
    expect(registered.length).toBeGreaterThan(1);
    for (const item of registered) expect(await identity(item.pid)).not.toBe(item.identity);
  } finally {
    await reclaim(registered);
    await rm(directory, { recursive: true, force: true });
  }
});
