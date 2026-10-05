import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import type { RuntimeBootstrap, CrawlRun } from '@zhiyun/contracts';
import { testEnvironment } from '../../tooling/scripts/test-environment.js';

async function request<T>(page: Page, path: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ({ path, body, key }) => {
      const bootstrap = await (
        window as typeof window & {
          zhiyunRuntime: { getBootstrap(): Promise<RuntimeBootstrap> };
        }
      ).zhiyunRuntime.getBootstrap();
      const session = await fetch(`${bootstrap.baseUrl}/api/v2/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce: bootstrap.sessionNonce }),
      });
      if (!session.ok) throw new Error(`Benchmark session HTTP ${session.status}`);
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
      if (!response.ok) throw new Error(`Benchmark ${path}: HTTP ${response.status}`);
      return response.json();
    },
    { path, body, key: randomUUID() },
  ) as Promise<T>;
}
async function browserTiming(page: Page, scriptUrls: Set<string>) {
  const timing = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0] as
      PerformanceNavigationTiming | undefined;
    const paints = performance.getEntriesByType('paint');
    const scripts = performance
      .getEntriesByType('resource')
      .filter((entry) => /\/assets\/.*\.js(?:\?|$)/.test(entry.name))
      .map((entry) => ({
        asset: new URL(entry.name).pathname.split('/').at(-1),
        startTimeMs: entry.startTime,
        durationMs: entry.duration,
      }));
    return {
      domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? null,
      firstContentfulPaintMs:
        paints.find((entry) => entry.name === 'first-contentful-paint')?.startTime ?? null,
      scripts,
    };
  });
  // The app:// protocol does not publish its script requests in Resource Timing.
  // Debugger.enable reports existing scripts as well as later dynamic imports.
  const loadedScripts = [...scriptUrls]
    .filter((url) => /\/assets\/.*\.js(?:\?|$)/.test(url))
    .map((url) => new URL(url).pathname.split('/').at(-1)!)
    .sort();
  return {
    ...timing,
    loadedScripts,
    chartScripts: loadedScripts.filter((name) => name.startsWith('AnalysisChart-')),
  };
}
async function artifact(path: string) {
  const contents = await readFile(path);
  return {
    path,
    bytes: contents.length,
    gzipBytesLevel9: gzipSync(contents, { level: 9 }).length,
    sha256: createHash('sha256').update(contents).digest('hex'),
  };
}

test('measure three isolated desktop launches and first chart paints with actual local analysis', async ({
  browserName,
}, info) => {
  void browserName;
  test.setTimeout(300000);
  const desktopRoot = resolve(import.meta.dirname, '..');
  const rows = Array.from({ length: 24 }, (_, i) => ({ group: `group-${i % 4}`, value: i + 1 }));
  const source = createServer((_incoming, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ items: rows }));
  });
  const samples = [];
  await new Promise<void>((done) => source.listen(0, '127.0.0.1', done));
  const address = source.address();
  if (!address || typeof address === 'string')
    throw new Error('Owned benchmark source did not bind');
  try {
    for (let index = 0; index < 3; index++) {
      const profile = await mkdtemp(join(tmpdir(), 'zy-loading-performance-'));
      console.info('LOADING_PERFORMANCE_PROFILE', profile);
      let app: ElectronApplication | undefined;
      try {
        const launchedAt = performance.now();
        app = await electron.launch({
          args: [desktopRoot, `--user-data-dir=${profile}`],
          cwd: desktopRoot,
          env: { ...testEnvironment(process.env), TMPDIR: profile, TMP: profile, TEMP: profile },
          timeout: 30000,
        });
        const page = await app.firstWindow({ timeout: 30000 });
        page.setDefaultTimeout(15000);
        await expect(page.getByRole('heading', { name: '首页', exact: true })).toBeVisible();
        const launchToHomeVisibleMs = performance.now() - launchedAt;
        const scriptUrls = new Set<string>();
        const debuggerSession = await page.context().newCDPSession(page);
        debuggerSession.on('Debugger.scriptParsed', ({ url }: { url: string }) =>
          scriptUrls.add(url),
        );
        await debuggerSession.send('Debugger.enable');
        const home = await browserTiming(page, scriptUrls);
        expect(home.chartScripts).toHaveLength(0);
        const prepareAt = performance.now();
        const task = await request<{ id: string }>(page, '/api/v2/tasks', {
          name: 'Loading performance fixture',
          startUrl: `http://127.0.0.1:${address.port}/`,
          instruction: 'Read local JSON',
          browserSettings: { enabled: false },
          networkPolicy: { allowPrivateNetworks: true },
          requestSettings: {
            retries: 0,
            concurrency: 1,
            delayMs: 0,
            maxRequests: 1,
            respectRobotsTxt: false,
          },
          datasetSettings: {
            mode: 'append',
            keyFields: ['__fixture_missing_key__'],
            detectRemoved: false,
          },
        });
        await request(page, `/api/v2/tasks/${task.id}/rules`, {
          name: 'Local JSON',
          generatedBy: 'human',
          definition: {
            list: {
              mode: 'http',
              rule: {
                type: 'json',
                container: '$.items[*]',
                fields: {
                  group: { path: '$.group', dataType: 'string' },
                  value: { path: '$.value', dataType: 'number' },
                },
              },
            },
            dedupe: { strategy: 'none' },
            limits: { maxRecords: 24 },
          },
        });
        const { runId } = await request<{ runId: string }>(
          page,
          `/api/v2/tasks/${task.id}/runs`,
          {},
        );
        await expect
          .poll(
            async () => {
              const run = await request<CrawlRun>(page, `/api/v2/runs/${runId}`);
              if (run.status === 'failed' || run.status === 'canceled')
                throw new Error(`Benchmark collection ${run.status}`);
              return run.status;
            },
            { timeout: 30000, intervals: [100, 250, 500] },
          )
          .toBe('succeeded');
        const datasets = await request<{ items: Array<{ id: string; rowCount: number }> }>(
          page,
          `/api/v2/datasets?sourceTaskId=${task.id}&limit=1`,
        );
        expect(datasets.items).toHaveLength(1);
        const datasetId = datasets.items[0]!.id;
        const snapshot = await request<{ id: string; status: string; rowCount: number }>(
          page,
          `/api/v2/datasets/${datasetId}/snapshots`,
          {},
        );
        expect(snapshot.status).toBe('ready');
        expect(snapshot.rowCount).toBe(24);
        const methods = await request<Array<{ id: string; version: string }>>(
          page,
          '/api/v2/analytics/methods',
        );
        const method = methods.find((entry) => entry.id === 'group.aggregate');
        expect(method).toBeTruthy();
        const job = await request<{ id: string }>(page, '/api/v2/analytics/jobs', {
          datasetId,
          snapshotId: snapshot.id,
          methodId: method!.id,
          methodVersion: method!.version,
          parameters: { groupFields: ['group'], valueFields: ['value'], aggregations: ['mean'] },
        });
        let resultId = '';
        await expect
          .poll(
            async () => {
              const state = await request<{ state: string; resultId: string | null }>(
                page,
                `/api/v2/analytics/jobs/${job.id}`,
              );
              if (state.state === 'failed' || state.state === 'canceled')
                throw new Error(`Benchmark analysis ${state.state}`);
              resultId = state.resultId ?? '';
              return state.state;
            },
            { timeout: 30000, intervals: [100, 250, 500] },
          )
          .toBe('succeeded');
        expect(resultId).not.toBe('');
        const result = await request<{
          methodId: string;
          workerVersion: string;
          series: Array<{ data: unknown[] }>;
        }>(page, `/api/v2/analytics/results/${resultId}`);
        expect(result.methodId).toBe('group.aggregate');
        expect(result.series[0]?.data).toHaveLength(4);
        const preparationMs = performance.now() - prepareAt;
        expect((await browserTiming(page, scriptUrls)).chartScripts).toHaveLength(0);
        const navigateAt = performance.now();
        await page.goto(`app://zhiyun/analytics/results/${resultId}`);
        await page.waitForFunction(
          () => {
            const canvas = document.querySelector<HTMLCanvasElement>('.analysis-chart canvas');
            if (!canvas?.width || !canvas.height) return false;
            const context = canvas.getContext('2d');
            if (!context) return false;
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            for (let i = 3; i < pixels.length; i += 4) if (pixels[i]! > 0) return true;
            return false;
          },
          undefined,
          { timeout: 15000, polling: 'raf' },
        );
        const navigateToChartPaintMs = performance.now() - navigateAt;
        await expect(page.getByTestId('analysis-chart-groups').getByRole('img')).toBeVisible();
        const chart = await browserTiming(page, scriptUrls);
        expect(chart.chartScripts).toHaveLength(1);
        const sample = {
          index: index + 1,
          launchToHomeVisibleMs,
          navigateToChartPaintMs,
          preparationMs,
          workerVersion: result.workerVersion,
          home,
          chart,
        };
        await debuggerSession.detach();
        samples.push(sample);
        console.info('LOADING_PERFORMANCE_SAMPLE', JSON.stringify(sample));
      } finally {
        if (app) await app.close();
        await rm(profile, { recursive: true, force: true });
      }
    }
    const names = await readdir(join(desktopRoot, 'dist/renderer/assets'));
    const bundles = await Promise.all([
      artifact(join(desktopRoot, 'packages/runtime/dist/utility-entry.js')),
      ...names
        .filter((name) => /^(?:AnalysisChart|TaskEditorPage|index)-.*\.js$/.test(name))
        .map((name) => artifact(join(desktopRoot, 'dist/renderer/assets', name))),
    ]);
    const report = {
      measuredAt: new Date().toISOString(),
      environment: {
        system: process.platform,
        arch: process.arch,
        node: process.version,
        nodeEnv: process.env.NODE_ENV,
      },
      method:
        'Three fresh Electron profiles in sequence, actual 24-row localhost Collection and Worker group.aggregate. Home timing is monotonic host launch to visible heading (includes Playwright assertion overhead). Chart timing is host navigation to first nontransparent Canvas pixel. Browser resource timing also recorded. Preparation is separate; OS file cache is uncontrolled. No parallel benchmark workload.',
      samples,
      bundles,
    };
    await writeFile(
      info.outputPath('loading-performance.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
    await info.attach('loading-performance', {
      body: JSON.stringify(report, null, 2),
      contentType: 'application/json',
    });
  } finally {
    await new Promise<void>((done, reject) =>
      source.close((error) => (error ? reject(error) : done())),
    );
  }
});
