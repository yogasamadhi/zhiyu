import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import type { AssistantDetail } from '@zhiyun/contracts';
import { testEnvironment } from '../../tooling/scripts/test-environment.js';

test('sends and restores a local estimate policy without presenting offline guidance as billed usage', async ({
  browserName,
}, info) => {
  void browserName;
  const directory = await mkdtemp(join(tmpdir(), 'zy-cost-e2e-'));
  console.info('ASSISTANT_COST_E2E_PROFILE', directory);
  const desktopRoot = resolve(import.meta.dirname, '..');
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      args: [desktopRoot, `--user-data-dir=${directory}`],
      cwd: desktopRoot,
      env: { ...testEnvironment(process.env), TMPDIR: directory, TMP: directory, TEMP: directory },
      timeout: 15_000,
    });
    const page = await app.firstWindow({ timeout: 15_000 });
    page.setDefaultTimeout(10_000);
    await expect(page.getByRole('heading', { name: '首页', exact: true })).toBeVisible();
    await page.goto('app://zhiyun/assistant');
    await expect(page.getByRole('heading', { name: '织云助手', exact: true })).toBeVisible();
    await page.getByTestId('assistant-cost-budget').locator('summary').click();
    await page.getByLabel('预估上限', { exact: true }).fill('1');
    await page.getByLabel('每次 AI 调用估价', { exact: true }).fill('0.25');
    await page.getByLabel('币种', { exact: true }).selectOption('USD');
    await page.getByLabel('发送给织云助手').fill('价格字段是什么意思？');
    const posted = page.waitForResponse(
      (response) =>
        /\/assistant\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname) &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const response = await posted;
    expect(response.status()).toBe(202);
    expect(response.request().postDataJSON()).toEqual({
      content: '价格字段是什么意思？',
      costBudget: { maximum: 1, perCallEstimate: 0.25, currency: 'USD' },
    });
    await expect(page.getByText('固定引导 · 尚未连接 AI 模型', { exact: false })).toBeVisible();
    const panel = page.getByTestId('assistant-cost-panel');
    await panel.locator('summary').click();
    await expect(panel).toContainText('Token：未知');
    await expect(panel).toContainText('费用未知 / 未结算');
    await expect(panel).toContainText('估算：未知 / 预估上限 US$1.00');
    await expect(panel).not.toContainText('$0.00');
    const id = new URL(page.url()).searchParams.get('conversation');
    expect(id).toBeTruthy();
    const restored = page.waitForResponse(
      (result) =>
        new URL(result.url()).pathname === `/api/v2/assistant/conversations/${id}` &&
        result.request().method() === 'GET',
    );
    await page.reload();
    await panel.locator('summary').click();
    await expect(panel).toContainText('估算：未知 / 预估上限 US$1.00');
    const restoredResponse = await restored;
    expect(restoredResponse.status()).toBe(200);
    const detail = (await restoredResponse.json()) as AssistantDetail;
    expect(detail.turn).toMatchObject({
      status: 'succeeded',
      costBudget: { maximum: 1, perCallEstimate: 0.25, currency: 'USD' },
      accounting: null,
    });
    await page.locator('.language-button').click();
    await expect(panel).toContainText('Token：Unknown');
    await expect(panel).toContainText('Cost unknown / Not settled');
    await expect(panel).toContainText('Estimate：Unknown / Estimated limit $1.00');
    await page.setViewportSize({ width: 360, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await panel.scrollIntoViewIfNeeded();
    await expect(panel.getByText('Cost unknown / Not settled', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath('assistant-cost-en-360.png'), fullPage: true });
    await info.attach('assistant-cost-policy-v1.json', {
      body: JSON.stringify({
        fixtureVersion: 'assistant-cost-policy-v1',
        provider: 'Offline guidance',
        budget: detail.turn?.costBudget,
        accounting: detail.turn?.accounting,
      }),
      contentType: 'application/json',
    });
  } finally {
    try {
      await app?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
      console.info('ASSISTANT_COST_E2E_STAGE', 'host closed and owned profile removed');
    }
  }
});
