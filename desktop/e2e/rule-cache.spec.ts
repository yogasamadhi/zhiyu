import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import type { AnalysisResult, CollectionDraft } from '@zhiyun/contracts';
import { testEnvironment } from '../../tooling/scripts/test-environment.js';

test('shows verified Mock rule reuse and manual clearing in the desktop editor', async ({
  browserName,
}, info) => {
  void browserName;
  const directory = await mkdtemp(join(tmpdir(), 'zy-cache-e2e-'));
  console.info('RULE_CACHE_E2E_PROFILE', directory);
  const desktopRoot = resolve(import.meta.dirname, '..');
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      args: [desktopRoot, `--user-data-dir=${directory}`],
      cwd: desktopRoot,
      env: { ...testEnvironment(process.env), TMPDIR: directory, TMP: directory, TEMP: directory },
      timeout: 15_000,
    });
    console.info('RULE_CACHE_E2E_STAGE', 'host launched');
    const page = await app.firstWindow({ timeout: 15_000 });
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(15_000);
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('heading', { name: '首页', exact: true })).toBeVisible();
    console.info('RULE_CACHE_E2E_STAGE', 'window ready');
    await page.goto('app://zhiyun/tasks/new?professional=1');
    console.info('RULE_CACHE_E2E_STAGE', 'editor opened');
    await page.getByLabel('任务名称').fill('Owned Mock rule cache fixture');
    await page
      .getByLabel('URL', { exact: true })
      .fill('http://127.0.0.1:45100/products?page=1&limit=1000&q=name');
    await page.getByLabel('我想获取什么').fill('name price');
    console.info('RULE_CACHE_E2E_STAGE', 'fields entered');
    await page.getByText('高级设置', { exact: true }).click();
    await page.getByLabel(/允许 localhost/).check();
    await page.getByLabel('使用 AI 辅助', { exact: true }).check();
    console.info('RULE_CACHE_E2E_STAGE', 'fixture configured');
    const analyze = async () => {
      const response = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/v2/rules/analyze' &&
          response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: /分析网页/ }).click();
      const completed = await response;
      expect(completed.status()).toBe(200);
      return (await completed.json()) as AnalysisResult;
    };
    const notice = page.getByTestId('rule-cache-status');
    const first = await analyze();
    console.info('RULE_CACHE_E2E_STAGE', 'first analysis returned');
    expect(first.cache).toMatchObject({ status: 'stored', providerCalls: 2, hitCount: 0 });
    await expect(notice).toContainText('缓存已保存');
    await expect(notice).toContainText('本次规则生成调用 2');
    await expect(page.getByRole('cell', { name: '织云商品 01', exact: true })).toBeVisible();
    const repeated = await analyze();
    console.info('RULE_CACHE_E2E_STAGE', 'cached analysis returned');
    expect(repeated.cache).toMatchObject({ status: 'hit', providerCalls: 0, hitCount: 1 });
    await expect(notice).toContainText('缓存命中');
    await expect(notice).toContainText('累计复用 1');
    await expect(notice).toContainText('本次规则生成调用 0');
    const clear = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/v2/rules/cache/clear',
    );
    await page.getByRole('button', { name: '清理规则缓存', exact: true }).click();
    const cleared = await clear;
    console.info('RULE_CACHE_E2E_STAGE', 'clear returned');
    expect(cleared.status()).toBe(200);
    expect(await cleared.json()).toEqual({ status: 'cleared', deleted: 1 });
    await expect(page.getByText('规则缓存已清理 · 1', { exact: true })).toBeVisible();
    await expect(notice).toHaveCount(0);
    await expect(page.getByRole('cell', { name: '织云商品 01', exact: true })).toBeVisible();
    const regenerated = await analyze();
    console.info('RULE_CACHE_E2E_STAGE', 'regeneration returned');
    expect(regenerated.cache).toMatchObject({ status: 'stored', providerCalls: 2, hitCount: 0 });
    await expect(notice).toContainText('缓存已保存');
    await expect(notice).toContainText('本次规则生成调用 2');
    await info.attach('mock-rule-cache-ui-v1.json', {
      body: JSON.stringify({
        fixtureVersion: 'mock-rule-cache-ui-v1',
        provider: 'Mock',
        first: first.cache,
        repeat: repeated.cache,
        afterClear: regenerated.cache,
      }),
      contentType: 'application/json',
    });
  } finally {
    try {
      if (app) {
        await app.close();
        console.info('RULE_CACHE_E2E_STAGE', 'host closed');
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
      console.info('RULE_CACHE_E2E_STAGE', 'owned profile removed');
    }
  }
});

test('shows action reuse and clearing through the default collection draft flow', async ({
  browserName,
}, info) => {
  void browserName;
  const directory = await mkdtemp(join(tmpdir(), 'zy-cache-e2e-'));
  console.info('ACTION_CACHE_E2E_PROFILE', directory);
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
    page.setDefaultNavigationTimeout(15_000);
    await expect(page.getByRole('heading', { name: '首页', exact: true })).toBeVisible();
    await page.goto('app://zhiyun/tasks/new');
    await page.getByLabel('页面网址').fill('http://127.0.0.1:45100/products');
    await page.getByLabel('数据目标').fill('Collect product names');
    await page.getByRole('button', { name: '下一步', exact: true }).click();
    await expect(page.getByRole('heading', { name: '要采集的字段', exact: true })).toBeVisible();
    await page.getByText('专业配置', { exact: true }).click();
    await page.getByText('页面访问与请求控制', { exact: true }).click();
    await page.getByText('网络访问策略', { exact: true }).click();
    await page.getByLabel('网络访问策略', { exact: true }).fill(
      JSON.stringify({
        allowPrivateNetworks: true,
        allowedHosts: [],
        allowedCidrs: [],
      }),
    );
    await page.getByLabel('网络访问策略', { exact: true }).blur();
    await page.getByText('浏览器操作', { exact: true }).click();
    await page.getByRole('button', { name: '高级 JSON', exact: true }).click();
    await page
      .getByLabel('浏览器操作 JSON')
      .fill(JSON.stringify([{ type: 'waitFor', selector: '.product-card' }]));
    const preview = async () => {
      const response = page.waitForResponse(
        (response) =>
          /\/collection-drafts\/[^/]+\/preview$/.test(new URL(response.url()).pathname) &&
          response.request().method() === 'POST',
      );
      await page.getByRole('button', { name: '预览数据', exact: true }).click();
      const result = await response;
      expect(result.status()).toBe(200);
      return (await result.json()) as CollectionDraft;
    };
    const notice = page.getByTestId('action-cache-summary');
    const first = await preview();
    expect(first.preview?.actionCache).toMatchObject({
      stages: 1,
      storedStages: 1,
      providerCalls: 0,
    });
    await expect(notice).toContainText('保存 1');
    await expect(notice).toContainText('修复调用 0');
    const repeated = await preview();
    expect(repeated.preview?.actionCache).toMatchObject({
      stages: 1,
      hitStages: 1,
      providerCalls: 0,
    });
    await expect(notice).toContainText('命中 1');
    const clear = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/v2/rules/cache/clear',
    );
    await page.getByRole('button', { name: '清理动作缓存', exact: true }).click();
    const cleared = await clear;
    expect(cleared.status()).toBe(200);
    expect(await cleared.json()).toEqual({ status: 'cleared', deleted: 1 });
    await expect(page.getByText('动作缓存已清理 · 1', { exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: '织云商品 01', exact: true })).toBeVisible();
    const regenerated = await preview();
    expect(regenerated.preview?.actionCache).toMatchObject({
      storedStages: 1,
      hitStages: 0,
      providerCalls: 0,
    });
    await expect(notice).toContainText('保存 1');
    await info.attach('mock-action-cache-ui-v1.json', {
      body: JSON.stringify({
        fixtureVersion: 'mock-action-cache-ui-v1',
        provider: 'Mock',
        first: first.preview?.actionCache,
        repeat: repeated.preview?.actionCache,
        afterClear: regenerated.preview?.actionCache,
      }),
      contentType: 'application/json',
    });
  } finally {
    try {
      await app?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
      console.info('ACTION_CACHE_E2E_STAGE', 'owned profile removed');
    }
  }
});
