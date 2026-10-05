import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
import type {
  CleaningResult,
  CleaningSessionDetail,
  CrawlRun,
  RuntimeBootstrap,
} from '@zhiyun/contracts';
import { testEnvironment } from '../../tooling/scripts/test-environment.js';

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

test('cleans through the actual desktop, reuses a version, restores history and preserves source Artifacts', async ({
  browserName,
}, info) => {
  void browserName;
  test.setTimeout(120_000);
  const profile = await mkdtemp(join(tmpdir(), 'zy-cleaning-e2e-'));
  console.info('CLEANING_E2E_PROFILE', profile);
  let rows = [
    { name: '  Alpha ', price: '12.5', when: '2026-01-01', contact: 'A|B|C' },
    { name: 'Beta', price: 'bad', when: 'bad', contact: 'D' },
    { name: '  Alpha ', price: '12.5', when: '2026-01-01', contact: 'A|B|C' },
    { name: '  ', price: 'N/A', when: null, contact: null },
  ];
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
    page.setDefaultTimeout(10_000);
    await expect(page.getByRole('heading', { name: '首页', exact: true })).toBeVisible();
    const task = await request<{ id: string }>(page, '/api/v2/tasks', {
      name: 'Local cleaning fixture',
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
              ['name', 'price', 'when', 'contact'].map((field) => [
                field,
                { path: `$.${field}`, dataType: 'json' },
              ]),
            ),
          },
        },
        dedupe: { strategy: 'none' },
        limits: { maxRecords: 100 },
      },
    });
    const collect = async () => {
      const { runId } = await request<{ runId: string }>(page, `/api/v2/tasks/${task.id}/runs`, {});
      let run: CrawlRun | undefined;
      await expect
        .poll(
          async () => {
            run = await request<CrawlRun>(page, `/api/v2/runs/${runId}`);
            if (['failed', 'canceled'].includes(run.status))
              throw new Error(`Run ${run.status}: ${run.error}`);
            return run.status;
          },
          { timeout: 30_000, intervals: [100, 250, 500] },
        )
        .toBe('succeeded');
      return run!;
    };
    await collect();
    console.info('CLEANING_E2E_STAGE', 'first collection completed');
    const datasets = await request<{ items: Array<{ id: string }> }>(
      page,
      `/api/v2/datasets?sourceTaskId=${task.id}&limit=1`,
    );
    const datasetId = datasets.items[0]!.id;
    await page.goto(`app://zhiyun/datasets/${datasetId}`);
    const panel = page.getByTestId('dataset-cleaning-panel');
    await expect(panel.getByRole('heading', { name: '清洗与数据版本' })).toBeVisible();
    await panel.getByRole('button', { name: '从当前采集创建输入版本', exact: true }).click();
    await expect(panel.getByLabel('清洗操作', { exact: true })).toBeEnabled();
    const inputId = await panel.getByLabel('清洗输入版本').inputValue();
    const before = await sourceEvidence(profile, inputId);
    const originalRecords = await request(page, `/api/v2/datasets/${datasetId}/records?limit=50`);
    await panel.getByLabel('清洗配方名称').fill('Complete local cleaning');
    const add = async (operation: string, fields: string[]) => {
      await panel.getByLabel('清洗操作', { exact: true }).selectOption(operation);
      await panel.getByLabel('清洗字段', { exact: true }).selectOption(fields);
      if (operation === 'split') {
        await panel.getByLabel('拆分目标字段 1').fill('first');
        await panel.getByLabel('拆分目标字段 2').fill('last');
      }
      if (operation === 'merge') {
        await panel.getByLabel('合并目标字段').fill('label');
        await panel.getByLabel('连接符', { exact: true }).fill(' / ');
      }
      await panel.getByRole('button', { name: '添加步骤', exact: true }).click();
    };
    await add('trim', ['name', 'price']);
    await add('normalize_null', ['name', 'price']);
    await add('number', ['price']);
    await add('date', ['when']);
    await add('split', ['contact']);
    await add('merge', ['first', 'last']);
    await add('dedupe', ['name', 'price']);
    const previewResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith('/cleaning/preview') &&
        response.request().postDataJSON()?.steps?.length === 7,
    );
    await panel.getByRole('button', { name: '预览清洗', exact: true }).click();
    const previewCompleted = await previewResponse;
    expect(previewCompleted.status()).toBe(200);
    const preview = (await previewCompleted.json()) as CleaningResult;
    expect(preview.steps).toHaveLength(7);
    expect(preview.steps[0]!.preview[0]!.before.name).toBe('  Alpha ');
    expect(preview.steps[0]!.preview[0]!.after?.name).toBe('Alpha');
    expect(preview.steps[1]!.outputQuality.fields.price?.nullCount).toBe(1);
    expect(preview.steps[2]!.errorRowCount).toBe(1);
    expect(preview.steps[3]!.errorRowCount).toBe(1);
    expect(preview.steps[4]!.preview[0]!.after).toMatchObject({ first: 'A', last: 'B|C' });
    expect(preview.steps[5]!.preview[0]!.after?.label).toBe('A / B|C');
    expect(preview.rowCount).toBe(3);
    expect(preview.steps[6]!.removedRowCount).toBe(1);
    await expect(panel.getByTestId('cleaning-summary')).toContainText('行数：3');
    await panel.getByLabel('查看步骤结果').selectOption('3');
    await expect(panel.getByTestId('cleaning-summary')).toContainText('转换错误行：1');
    await expect(panel.getByRole('table', { name: '清洗转换预览' })).toContainText('无法转为数字');
    await panel.getByRole('button', { name: '保存清洗配方', exact: true }).click();
    await expect(panel.getByTestId('cleaning-recipe-version')).toContainText('v1');
    const publishResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith('/cleaning/sessions') &&
        response.request().method() === 'POST',
    );
    await panel.getByRole('button', { name: '应用配方并保存结果', exact: true }).click();
    const published = await publishResponse;
    expect(published.status()).toBe(201);
    const first = (await published.json()) as CleaningSessionDetail;
    await expect(panel.getByTestId('cleaning-history-selection')).toContainText(
      '当前选择步骤：7/7',
    );
    expect(await sourceEvidence(profile, inputId)).toEqual(before);
    expect(await request(page, `/api/v2/datasets/${datasetId}/records?limit=50`)).toEqual(
      originalRecords,
    );
    for (let step = 6; step >= 0; step--) {
      await panel.getByRole('button', { name: '撤销一步', exact: true }).click();
      await expect(panel.getByTestId('cleaning-history-selection')).toContainText(
        `当前选择步骤：${step}/7`,
      );
    }
    await expect(panel.getByTestId('cleaning-history-selection')).toContainText(
      inputId.slice(0, 8),
    );
    for (let step = 1; step <= 7; step++) {
      await panel.getByRole('button', { name: '重做一步', exact: true }).click();
      await expect(panel.getByTestId('cleaning-history-selection')).toContainText(
        `当前选择步骤：${step}/7`,
      );
    }
    const finalId = first.session.outputSnapshotIds[6]!;
    await page.getByRole('button', { name: '开始分析', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`snapshotId=${finalId}`));
    await page.goto(`app://zhiyun/datasets/${datasetId}`);
    await panel.getByRole('button', { name: '查看清洗历史', exact: false }).first().click();
    await expect(panel.getByTestId('cleaning-history-selection')).toContainText(
      '当前选择步骤：7/7',
    );
    await panel.getByRole('button', { name: '复用此配方版本', exact: true }).click();
    rows = [
      { name: ' Gamma ', price: '9', when: 'bad', contact: 'E|F' },
      { name: 'Delta', price: 'bad', when: null, contact: null },
    ];
    await collect();
    await panel.getByRole('button', { name: '从当前采集创建输入版本', exact: true }).click();
    await expect(panel.getByLabel('清洗输入版本')).not.toHaveValue(inputId);
    await expect(panel.getByLabel('清洗操作', { exact: true })).toBeEnabled();
    const secondInputId = await panel.getByLabel('清洗输入版本').inputValue();
    expect(secondInputId).not.toBe(inputId);
    await expect(page.getByRole('heading', { name: '原始采集记录' }).locator('..')).toContainText(
      'Gamma',
    );
    const reuseResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith('/cleaning/preview') &&
        response.request().postDataJSON()?.mode === 'recipe',
    );
    await panel.getByRole('button', { name: '预览清洗', exact: true }).click();
    const reuse = await reuseResponse;
    expect(reuse.status()).toBe(200);
    expect(reuse.request().postDataJSON()).toEqual({
      mode: 'recipe',
      snapshotId: secondInputId,
      recipeVersionId: first.recipeVersion.id,
    });
    await panel.getByRole('button', { name: '应用配方并保存结果', exact: true }).click();
    await expect(panel.getByTestId('cleaning-history-selection')).toContainText(
      '当前选择步骤：7/7',
    );
    const sessions = await request<Array<{ id: string }>>(
      page,
      `/api/v2/datasets/${datasetId}/cleaning/sessions`,
    );
    expect(sessions).toHaveLength(2);
    await panel.getByLabel('清洗输入版本').selectOption(finalId);
    const invalidResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith('/cleaning/preview') &&
        response.request().postDataJSON()?.mode === 'recipe',
    );
    await panel.getByRole('button', { name: '预览清洗', exact: true }).click();
    expect((await invalidResponse).status()).toBe(400);
    await expect(panel.getByRole('alert')).toContainText('different type');
    await expect(panel.getByRole('alert')).toContainText('输入字段、类型或参数不兼容');
    expect(await sourceEvidence(profile, inputId)).toEqual(before);
    expect(await request(page, `/api/v2/datasets/${datasetId}/cleaning/sessions`)).toHaveLength(2);
    await panel.getByRole('button', { name: '查看清洗历史', exact: false }).first().click();
    await page.locator('.language-button').click();
    await expect(panel.getByRole('heading', { name: 'Cleaning and data versions' })).toBeVisible();
    await page.setViewportSize({ width: 360, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('cleaning-en-360.png'), fullPage: true });
    await info.attach('cleaning-desktop-v1.json', {
      body: JSON.stringify({
        fixtureVersion: 'cleaning-desktop-v1',
        operations: preview.steps.map((step) => step.operation),
        inputSnapshotId: inputId,
        secondInputSnapshotId: secondInputId,
        recipeVersionId: first.recipeVersion.id,
        sourceArtifactsUnchanged: true,
        historyCount: 2,
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
      console.info('CLEANING_E2E_STAGE', 'host, fixture and owned profile removed');
    }
  }
});
