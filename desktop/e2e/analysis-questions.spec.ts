import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import type { RuntimeBootstrap, CrawlRun } from '@zhiyun/contracts';
import { testEnvironment } from '../../tooling/scripts/test-environment.js';

type AnalysisJob = { state: string; error: unknown; resultId: string | null };
type AnalyticsResult = {
  id: string;
  methodId: string;
  snapshotId: string;
  parameters: Record<string, unknown>;
  artifacts: Array<Record<string, unknown>>;
  provenance: {
    sourceSnapshotId: string;
    cleaningRecipeVersionId: string | null;
    analysisRecipeRevision: number | null;
    analysisRecipeId: string | null;
    parentResultId: string | null;
  } | null;
};

async function request<T>(page: Page, path: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ({ path, body, key }) => {
      const bootstrap = await (
        window as typeof window & { zhiyunRuntime: { getBootstrap(): Promise<RuntimeBootstrap> } }
      ).zhiyunRuntime.getBootstrap();
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

async function sourceEvidence(profile: string, snapshotId: string) {
  // Read only the fresh profile created by this test, never the normal desktop database.
  const database = new DatabaseSync(join(profile, 'zhiyun.sqlite3'), { readOnly: true });
  try {
    const snapshot = database
      .prepare('SELECT * FROM dataset_snapshots WHERE id=?')
      .get(snapshotId)!;
    if (
      typeof snapshot.parquet_artifact_id !== 'string' ||
      typeof snapshot.manifest_artifact_id !== 'string'
    )
      throw new Error('Ready input is missing its Artifact IDs');
    const artifacts = database
      .prepare('SELECT id,storage_key,checksum FROM platform_artifacts WHERE id IN (?,?)')
      .all(snapshot.parquet_artifact_id, snapshot.manifest_artifact_id);
    const files = [];
    for (const artifact of artifacts) {
      const contents = await readFile(join(profile, 'artifacts', String(artifact.storage_key)));
      const checksum = createHash('sha256').update(contents).digest('hex');
      expect(checksum).toBe(artifact.checksum);
      files.push({ id: artifact.id, checksum });
    }
    expect(files).toHaveLength(2);
    return { snapshot, files };
  } finally {
    database.close();
  }
}

test('four desktop questions preserve input history, branches, paged tables and chart failure fallback', async ({
  browserName,
}, info) => {
  void browserName;
  test.setTimeout(180_000);
  const profile = await mkdtemp(join(tmpdir(), 'zy-analysis-questions-e2e-'));
  console.info('ANALYSIS_QUESTIONS_PROFILE', profile);
  let rows = Array.from({ length: 550 }, (_, index) => ({
    group: `group-${String(index).padStart(4, '0')}`,
    value: ` ${index === 549 ? 40 : index % 10} `,
    date: new Date(Date.UTC(2024, 0, 1 + index)).toISOString(),
  }));
  const source = createServer((_incoming, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ items: rows }));
  });
  let app: ElectronApplication | undefined;
  try {
    await new Promise<void>((done) => source.listen(0, '127.0.0.1', done));
    const address = source.address();
    if (!address || typeof address === 'string') throw new Error('Owned fixture did not bind');
    const desktopRoot = resolve(import.meta.dirname, '..');
    app = await electron.launch({
      args: [desktopRoot, `--user-data-dir=${profile}`],
      cwd: desktopRoot,
      env: { ...testEnvironment(process.env), TMPDIR: profile, TMP: profile, TEMP: profile },
      timeout: 15_000,
    });
    const page = await app.firstWindow({ timeout: 15_000 });
    page.on('pageerror', (error) => console.info('ANALYSIS_QUESTIONS_PAGE_ERROR', error.message));
    page.on('console', (message) => {
      if (message.type() === 'error')
        console.info('ANALYSIS_QUESTIONS_RENDER_ERROR', message.text().slice(0, 1000));
    });
    page.setDefaultTimeout(10_000);
    await expect(page.getByRole('heading', { name: '首页', exact: true })).toBeVisible();
    const task = await request<{ id: string }>(page, '/api/v2/tasks', {
      name: 'Local analysis question fixture',
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
            fields: Object.fromEntries(
              ['group', 'value', 'date'].map((field) => [
                field,
                { path: `$.${field}`, dataType: 'json' },
              ]),
            ),
          },
        },
        dedupe: { strategy: 'none' },
        limits: { maxRecords: 1000 },
      },
    });
    const collect = async () => {
      const { runId } = await request<{ runId: string }>(page, `/api/v2/tasks/${task.id}/runs`, {});
      await expect
        .poll(
          async () => {
            const run = await request<CrawlRun>(page, `/api/v2/runs/${runId}`);
            if (['failed', 'canceled'].includes(run.status))
              throw new Error(`Run ${run.status}: ${run.error}`);
            return run.status;
          },
          { timeout: 30_000, intervals: [100, 250, 500] },
        )
        .toBe('succeeded');
    };
    await collect();
    const datasets = await request<{ items: Array<{ id: string }> }>(
      page,
      `/api/v2/datasets?sourceTaskId=${task.id}&limit=1`,
    );
    const datasetId = datasets.items[0]!.id;
    const input = await request<{ id: string }>(
      page,
      `/api/v2/datasets/${datasetId}/snapshots`,
      {},
    );
    const before = await sourceEvidence(profile, input.id);
    const saved = await request<{ version: { id: string } }>(
      page,
      `/api/v2/datasets/${datasetId}/cleaning/recipes`,
      {
        name: 'Typed analysis input',
        expectedFields: {},
        steps: [
          { type: 'trim', fields: ['value'] },
          { type: 'convert', fields: ['value'], targetType: 'number', onError: 'null' },
          { type: 'convert', fields: ['date'], targetType: 'date', onError: 'null' },
        ],
      },
    );
    const cleaned = await request<{ session: { selectedSnapshotId: string } }>(
      page,
      `/api/v2/datasets/${datasetId}/cleaning/sessions`,
      { snapshotId: input.id, recipeVersionId: saved.version.id },
    );
    const snapshotId = cleaned.session.selectedSnapshotId;
    const results: AnalyticsResult[] = [];
    const waitResult = async () => {
      await expect(page).toHaveURL(/\/analytics\/jobs\/[0-9a-f-]{36}/);
      const jobId = new URL(page.url()).pathname.split('/').at(-1)!;
      let job: AnalysisJob | undefined;
      await expect
        .poll(
          async () => {
            job = await request<AnalysisJob>(page, `/api/v2/analytics/jobs/${jobId}`);
            if (job.state === 'failed') throw new Error(JSON.stringify(job.error));
            return job.state;
          },
          { timeout: 30_000, intervals: [100, 250, 500] },
        )
        .toBe('succeeded');
      await expect(page.getByRole('heading', { name: '分析结果', exact: true })).toBeVisible();
      return request<AnalyticsResult>(page, `/api/v2/analytics/results/${job!.resultId}`);
    };
    for (const [title, methodId, tableId] of [
      ['分组比较', 'group.aggregate', 'groups'],
      ['时间趋势', 'time.trend', 'trend'],
      ['数值分布', 'stats.descriptive', 'descriptive'],
      ['异常点', 'stats.outliers', 'outlierSummary'],
    ] as const) {
      await page.goto(`app://zhiyun/analytics?datasetId=${datasetId}&snapshotId=${snapshotId}`);
      const question = page.getByRole('button', { name: title, exact: true });
      await expect(question).toBeEnabled();
      await question.click();
      await expect(question).toHaveAttribute('aria-pressed', 'true');
      await page.getByRole('button', { name: '开始分析', exact: true }).click();
      const result = await waitResult();
      expect(result.methodId).toBe(methodId);
      expect(result.snapshotId).toBe(snapshotId);
      expect(result.provenance).toMatchObject({
        sourceSnapshotId: input.id,
        cleaningRecipeVersionId: saved.version.id,
        analysisRecipeRevision: 1,
      });
      expect(result.provenance?.analysisRecipeId).toBeTruthy();
      await expect(page.getByTestId(`analysis-table-${tableId}`)).toBeVisible();
      await expect(page.getByTestId(`analysis-chart-${tableId}`).getByRole('img')).toBeVisible();
      results.push(result);
      console.info('ANALYSIS_QUESTIONS_STAGE', title, 'complete');
    }
    const groups = results[0]!;
    const mainArtifact = groups.artifacts.find((artifact) => artifact.kind === 'analysis.result');
    expect(mainArtifact?.id).toBeTruthy();
    const database = new DatabaseSync(join(profile, 'zhiyun.sqlite3'), { readOnly: true });
    let artifactPath: string;
    try {
      const metadata = database
        .prepare('SELECT storage_key FROM platform_artifacts WHERE id=?')
        .get(String(mainArtifact!.id))!;
      artifactPath = join(profile, 'artifacts', String(metadata.storage_key));
    } finally {
      database.close();
    }
    await rename(artifactPath, `${artifactPath}.offline`);
    try {
      await page.goto(`app://zhiyun/analytics/results/${groups.id}`);
      const table = page.getByTestId('analysis-table-groups');
      await expect(table.locator('tbody tr')).toHaveCount(20);
      await expect(table).toContainText('共 550 行');
      const allGroups = await table.locator('tbody tr td:first-child').allTextContents();
      while (await table.getByRole('button', { name: '下一页', exact: true }).isEnabled()) {
        const first = await table.locator('tbody tr td:first-child').first().textContent();
        await table.getByRole('button', { name: '下一页', exact: true }).click();
        await expect(table.locator('tbody tr td:first-child').first()).not.toHaveText(first!);
        allGroups.push(...(await table.locator('tbody tr td:first-child').allTextContents()));
      }
      expect(allGroups).toHaveLength(550);
      expect(new Set(allGroups).size).toBe(550);
      await table.getByRole('button', { name: '上一页', exact: true }).click();
      await expect(table.locator('tbody tr')).toHaveCount(50);
      const chart = page.getByTestId('analysis-chart-groups');
      await chart.getByRole('button', { name: '下一页', exact: true }).click();
      await expect(chart).toContainText('21–70');
      await expect(chart.getByRole('img')).toBeVisible();
    } finally {
      await rename(`${artifactPath}.offline`, artifactPath);
    }
    const parent = results[3]!;
    await page.goto(`app://zhiyun/analytics/results/${parent.id}`);
    const branch = page.getByTestId('analysis-branch');
    await branch.getByRole('button', { name: '编辑分支参数', exact: true }).click();
    await branch.getByLabel('异常阈值', { exact: true }).fill('11');
    await expect(branch.getByRole('button', { name: '运行新分支', exact: true })).toBeDisabled();
    await branch.getByLabel('异常阈值', { exact: true }).fill('10');
    await branch.getByRole('button', { name: '运行新分支', exact: true }).click();
    const child = await waitResult();
    expect(child.provenance?.parentResultId).toBe(parent.id);
    expect(child.parameters.threshold).toBe(10);
    expect(await request(page, `/api/v2/analytics/results/${parent.id}`)).toEqual(parent);
    const compare = page.getByTestId('analysis-comparison');
    await compare.getByRole('button', { name: '开始比较', exact: true }).click();
    await expect(compare).toContainText('异常阈值');
    await expect(compare.getByTestId('analysis-table-outlierSamples')).toHaveCount(2);
    await expect(compare).toContainText('没有记录');
    await compare.getByLabel('或输入结果 ID', { exact: true }).fill(groups.id);
    await compare.getByRole('button', { name: '开始比较', exact: true }).click();
    await expect(compare.getByRole('alert')).toContainText(/method|方法/i);
    await page.getByRole('link', { name: new RegExp(`^${saved.version.id}`) }).click();
    const frozen = page.getByTestId('frozen-analysis-input');
    await expect(frozen).toContainText(snapshotId);
    await expect(frozen).toContainText('Typed analysis input');
    await expect(frozen).toContainText('convert');
    expect(await sourceEvidence(profile, input.id)).toEqual(before);

    await page.addInitScript(
      `const original = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function(...args) { if (location.search.includes('chartFailure=1')) throw new Error('Owned chart render failure'); return Reflect.apply(original, this, args); };`,
    );
    await page.goto(`app://zhiyun/analytics/results/${groups.id}?chartFailure=1`);
    await expect(page.getByTestId('analysis-chart-groups')).toContainText('图表加载或渲染失败');
    await expect(page.getByTestId('analysis-table-groups').locator('tbody tr')).toHaveCount(20);
    await expect(page.getByRole('heading', { name: '分析结果', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 360, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.screenshot({
      path: info.outputPath('analysis-chart-fallback-zh-360.png'),
      fullPage: true,
    });
    await page.locator('.mobile-topbar button[aria-controls="workspace-navigation"]').click();
    await page.locator('.language-button').click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('analysis-chart-groups')).toContainText(
      'The chart could not load or render',
    );
    await page.screenshot({
      path: info.outputPath('analysis-chart-fallback-en-360.png'),
      fullPage: true,
    });
    await page.locator('.mobile-topbar button[aria-controls="workspace-navigation"]').click();
    await page.locator('.language-button').click();
    await page.keyboard.press('Escape');
    let blockedCharts = 0;
    await page.route('**/assets/AnalysisChart-*.js', async (route) => {
      blockedCharts += 1;
      await route.abort();
    });
    await page.goto(`app://zhiyun/analytics/results/${groups.id}?chartLoadFailure=1`);
    await expect(page.getByTestId('analysis-chart-groups')).toContainText('图表加载或渲染失败');
    await expect(page.getByTestId('analysis-table-groups').locator('tbody tr')).toHaveCount(20);
    expect(blockedCharts).toBeGreaterThan(0);
    await page.unroute('**/assets/AnalysisChart-*.js');
    rows = [{ group: 'text only', value: 'not a number', date: 'not a date' }];
    await collect();
    const textInput = await request<{ id: string }>(
      page,
      `/api/v2/datasets/${datasetId}/snapshots`,
      {},
    );
    await page.goto(`app://zhiyun/analytics?datasetId=${datasetId}&snapshotId=${textInput.id}`);
    for (const title of ['分组比较', '时间趋势', '数值分布', '异常点'])
      await expect(page.getByRole('button', { name: title, exact: true })).toBeDisabled();
    await expect(page.getByRole('region', { name: '你想了解什么？' })).toContainText(
      '缺少数值字段',
    );
    await expect(page.getByRole('region', { name: '你想了解什么？' })).toContainText(
      '缺少时间字段',
    );
    await info.attach('analysis-questions-desktop-v1.json', {
      body: JSON.stringify({
        fixtureVersion: 'analysis-questions-desktop-v1',
        questionMethods: results.map((result) => result.methodId),
        inputSnapshotId: input.id,
        cleanedSnapshotId: snapshotId,
        cleaningRecipeVersionId: saved.version.id,
        pagedGroups: 550,
        uniquePagedGroups: 550,
        artifactOfflineWhilePaging: true,
        parentPreserved: true,
        branchThreshold: 10,
        incompatibleCompareRejected: true,
        chartRenderFallback: true,
        chartLoadFallback: true,
        sourceArtifactsUnchanged: true,
      }),
      contentType: 'application/json',
    });
  } finally {
    try {
      await app?.close();
    } finally {
      source.closeAllConnections();
      if (source.listening) await new Promise<void>((done) => source.close(() => done()));
      await rm(profile, { recursive: true, force: true });
      console.info('ANALYSIS_QUESTIONS_STAGE', 'host, fixture and owned profile removed');
    }
  }
});
