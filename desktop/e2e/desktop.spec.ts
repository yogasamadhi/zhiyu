import {
  exerciseCollectionExperience,
  exerciseWorkspaceLayouts,
} from '../tooling/e2e/experience.js';
import { exerciseAssistant } from '../tooling/e2e/assistant.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { testEnvironment } from '../../tooling/scripts/test-environment.js';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

let electronApp: ElectronApplication;
let page: Page;
let profile = '';

test.beforeAll(async () => {
  const desktopRoot = resolve(import.meta.dirname, '..');
  profile = await mkdtemp(join(tmpdir(), 'zhiyun-desktop-e2e-'));
  electronApp = await electron.launch({
    args: [desktopRoot, `--user-data-dir=${profile}`],
    cwd: desktopRoot,
    env: testEnvironment(process.env),
  });
  if (process.env.ZHIYUN_E2E_LOG === '1') {
    electronApp.process().stdout?.on('data', (chunk) => process.stdout.write(String(chunk)));
    electronApp.process().stderr?.on('data', (chunk) => process.stderr.write(String(chunk)));
  }
  page = await electronApp.firstWindow();
  if (process.env.ZHIYUN_E2E_LOG === '1') {
    page.on('console', (message) => console.log(`[renderer:${message.type()}] ${message.text()}`));
    page.on('pageerror', (error) => console.error('[renderer:error]', error));
    page.on('requestfailed', (request) =>
      console.error(`[renderer:requestfailed] ${request.url()} ${request.failure()?.errorText}`),
    );
  }
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await electronApp?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});

test.afterEach(async () => {
  await page
    .evaluate(() =>
      (
        window as typeof window & { restoreDiagnosticExport?: () => void }
      ).restoreDiagnosticExport?.(),
    )
    .catch(() => undefined);
  for (const window of electronApp.windows().filter((candidate) => candidate !== page)) {
    await window.close().catch(() => undefined);
  }
});

test('assistant teaches and restores progress in the desktop host', async ({
  browserName,
}, info) => {
  void browserName;
  test.setTimeout(120_000);
  await exerciseAssistant(page, 'app://zhiyun', info);
});

test('renders the crawler assistant without a Renderer crash', async () => {
  const errors: string[] = [];
  const recordError = (error: Error) => errors.push(error.stack ?? error.message);
  page.on('pageerror', recordError);
  try {
    await page.goto('app://zhiyun/');
    await page.goto('app://zhiyun/tasks/new?assistant=1');
    await expect(page.getByRole('heading', { name: '织云助手', exact: true })).toBeVisible();
    await expect(page.getByText('固定引导与离线练习可用')).toBeVisible();
    await page.getByRole('link', { name: '采集任务' }).first().click();
    await expect(page.getByRole('heading', { name: '采集任务' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    page.off('pageerror', recordError);
  }
});

test('reviews three local list/detail samples and runs a manual draft into its Dataset', async () => {
  test.setTimeout(120_000);
  await page.goto('app://zhiyun/tasks/new');
  await page.getByLabel('页面网址').fill('http://127.0.0.1:45100/preview/static');
  await page.getByLabel('数据目标').fill('采集名称、价格和对应详情');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByText('专业配置', { exact: true }).click();
  await page.getByText('提取规则、分页与详情', { exact: true }).click();
  const rule = page.getByLabel('提取规则、分页与详情', { exact: true });
  await rule.fill(
    JSON.stringify({
      list: {
        rule: {
          type: 'css',
          container: '.preview-item',
          fields: {
            名称: { selector: 'h2', dataType: 'string' },
            价格: { selector: '.price', dataType: 'number' },
            链接: {
              selector: '.detail-link',
              value: 'attribute',
              attribute: 'href',
              dataType: 'url',
            },
          },
        },
      },
      detail: {
        urlField: '链接',
        rule: {
          type: 'css',
          container: 'main.detail',
          fields: { 描述: { selector: '.description', dataType: 'string' } },
        },
      },
    }),
  );
  await rule.blur();
  await page.getByText('页面访问与请求控制', { exact: true }).click();
  await page.getByText('网络访问策略', { exact: true }).click();
  const network = page.getByLabel('网络访问策略', { exact: true });
  await network.fill(
    JSON.stringify({ allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] }),
  );
  await network.blur();
  await page.getByRole('button', { name: '预览数据', exact: true }).click();
  const quality = page.getByRole('table', { name: '字段质量', exact: true });
  await expect(quality).toBeVisible();
  await expect(quality.getByRole('row').filter({ hasText: '描述' })).toContainText('详情页');
  for (let index = 1; index <= 3; index++) {
    await page.getByRole('button', { name: `样本 ${index}`, exact: true }).click();
    await expect(page.getByText('每条列表记录对应一个详情记录', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: '确认此样本', exact: true }).click();
  }
  await expect(
    page.getByText('已检查 3/3 条；列表规则建议至少检查三个不同样本。', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByLabel('任务名称', { exact: true }).fill(`三样本预览 ${Date.now()}`);
  await page.getByRole('button', { name: '保存并运行', exact: true }).click();
  const result = page.getByRole('link', { name: '查看任务与结果', exact: true });
  await expect(result).toBeVisible();
  const taskId = (await result.getAttribute('href'))!.split('/')[2]!;
  await result.click();
  await expect(page.getByText('已完成', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await page.goto(`app://zhiyun/tasks/${taskId}/runs`);
  const runLink = page.locator('a[href^="/runs/"]').first();
  const runPath = (await runLink.getAttribute('href'))!;
  await page.goto(`app://zhiyun${runPath}`);
  await expect(page.getByRole('heading', { name: '采集步骤诊断', exact: true })).toBeVisible();
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: '采集暂存' })
      .getByRole('cell', { name: '3 条已写入', exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: '结果更新' })
      .getByRole('cell', { name: '3 条已写入', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const originalCreate = URL.createObjectURL;
    const originalClick = HTMLAnchorElement.prototype.click;
    const state = window as typeof window & {
      diagnosticExport?: Promise<string>;
      diagnosticFilename?: string;
      restoreDiagnosticExport?: () => void;
    };
    state.restoreDiagnosticExport = () => {
      URL.createObjectURL = originalCreate;
      HTMLAnchorElement.prototype.click = originalClick;
      delete state.diagnosticExport;
      delete state.diagnosticFilename;
      delete state.restoreDiagnosticExport;
    };
    URL.createObjectURL = (blob) => {
      if (blob instanceof Blob && blob.type === 'application/json')
        state.diagnosticExport = blob.text();
      return originalCreate(blob);
    };
    HTMLAnchorElement.prototype.click = function () {
      if (this.download.endsWith('-diagnostics.json')) {
        state.diagnosticFilename = this.download;
        return;
      }
      originalClick.call(this);
    };
  });
  await page.getByRole('button', { name: '导出诊断包', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as typeof window & { diagnosticFilename?: string }).diagnosticFilename,
      ),
    )
    .toContain('-diagnostics.json');
  const exported = await page.evaluate(
    async () =>
      await (window as typeof window & { diagnosticExport?: Promise<string> }).diagnosticExport,
  );
  await page.evaluate(() =>
    (
      window as typeof window & { restoreDiagnosticExport?: () => void }
    ).restoreDiagnosticExport?.(),
  );
  expect(JSON.parse(exported!).run.id).toBe(runPath.split('/')[2]);
  expect(exported).not.toContain('http://127.0.0.1');
  expect(exported).not.toContain('样本商品');
  expect(Buffer.byteLength(exported!)).toBeLessThanOrEqual(64 * 1024);
  await page.getByRole('button', { name: '清理本次诊断', exact: true }).click();
  await expect(
    page.getByText('暂无步骤诊断；历史运行或诊断暂不可用时，采集结果仍可查看。', { exact: true }),
  ).toBeVisible();
  await page.goto(`app://zhiyun/tasks/${taskId}/dataset`);
  await expect(page.getByRole('cell', { name: '样本商品 3', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '样本商品 3 的详情', exact: true })).toBeVisible();
});

test('selects a curated AI provider and model without an editable Base URL', async () => {
  await page.goto('app://zhiyun/settings?section=ai');
  await expect(page.getByRole('heading', { name: 'AI 模型连接' })).toBeVisible();

  const providerSelect = page.getByLabel('模型厂商');
  const modelSelect = page.getByLabel('模型 ID');
  await expect(providerSelect.locator('option')).toHaveCount(13);
  await providerSelect.selectOption('deepseek');

  await expect(modelSelect).toHaveValue('deepseek-v4-pro');
  await expect(modelSelect.locator('option')).toHaveCount(2);
  await expect(page.getByText('https://api.deepseek.com', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '官方模型文档' })).toHaveAttribute(
    'href',
    'https://api-docs.deepseek.com/updates',
  );
  await expect(page.getByLabel('Base URL')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存 Provider' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '配置 Key' })).toBeVisible();
});

test('uses a sandboxed Renderer and completes the desktop static workflow', async () => {
  const taskCreationRequests: string[] = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      request.method() === 'POST' &&
      (pathname === '/api/v2/tasks' || pathname === '/api/v2/tasks/initialize')
    ) {
      taskCreationRequests.push(pathname);
    }
  });
  await page.goto('app://zhiyun/');
  expect(await page.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe(
    'undefined',
  );
  expect(await page.evaluate(() => Object.keys(window.zhiyunRuntime!))).toEqual([
    'getBootstrap',
    'onBootstrapChanged',
  ]);
  await page
    .getByRole('link', { name: /新建任务/ })
    .first()
    .click();
  await page.goto('app://zhiyun/tasks/new?professional=1');
  await page.getByLabel('任务名称').fill(`Desktop fixture ${Date.now()}`);
  const startUrl = page.getByLabel('URL', { exact: true });
  await expect(startUrl).toHaveValue('');
  await startUrl.fill('http://127.0.0.1:45100/products');
  await page.getByText('高级设置').click();
  await page.getByLabel(/允许 localhost/).check();
  await page.getByRole('button', { name: /分析网页/ }).click();
  await expect(page.getByRole('heading', { name: '提取规则' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '织云商品 01', exact: true })).toBeVisible();
  expect(taskCreationRequests).toEqual([]);
  await page.getByRole('button', { name: '确认并保存规则' }).click();
  await expect(page.getByText('规则版本已保存')).toBeVisible();
  expect(taskCreationRequests).toEqual(['/api/v2/tasks/initialize']);
  const taskId = page.url().match(/tasks\/([^/]+)\/edit/)?.[1];
  expect(taskId).toBeTruthy();
  await page.goto(`app://zhiyun/tasks/${taskId}`);
  await page.getByRole('button', { name: '运行' }).click();
  await expect(page.locator('.page-heading .badge')).toHaveText('已完成');
  await expect(page.getByRole('cell', { name: '织云商品 10', exact: true })).toBeVisible();
});

test('uses bundled Playwright for a dynamic desktop task', async () => {
  await page.goto('app://zhiyun/tasks/new?professional=1');
  await page.getByLabel('任务名称').fill(`Desktop dynamic ${Date.now()}`);
  await page.getByLabel('URL').fill('http://127.0.0.1:45100/dynamic-products');
  await page.getByText('高级设置').click();
  await page.getByLabel(/允许 localhost/).check();
  await page.getByLabel('使用浏览器').check();
  await page.getByLabel('分页方式').selectOption('loadMore');
  await page.getByLabel('分页按钮 Selector').fill('#load-more');
  await page.getByRole('button', { name: /分析网页/ }).click();
  await expect(page.getByRole('cell', { name: '织云商品 01', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认并保存规则' }).click();
  await expect(page.getByText('规则版本已保存')).toBeVisible();
  await expect(page).toHaveURL(/tasks\/[^/]+\/edit/);
  const taskId = page.url().match(/tasks\/([^/]+)\/edit/)?.[1];
  expect(taskId).toBeTruthy();
  await page.goto(`app://zhiyun/tasks/${taskId}`);
  await page.getByRole('button', { name: '运行' }).click();
  await expect(page.locator('.page-heading .badge')).toHaveText('已完成', { timeout: 40_000 });
  await expect(page.getByRole('cell', { name: '织云商品 30', exact: true })).toBeVisible();
  await expect(page.getByText('Browser', { exact: true })).toBeVisible();
});

test('captures an isolated login session and crawls an authenticated page', async () => {
  await page.goto('app://zhiyun/tasks/new?professional=1');
  await page.getByLabel('任务名称').fill(`Desktop login ${Date.now()}`);
  await page.getByLabel('URL').fill('http://127.0.0.1:45100/private-products');
  await page.getByText('高级设置').click();
  await page.getByLabel(/允许 localhost/).check();
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page).toHaveURL(/tasks\/[^/]+\/edit/);
  await page.getByLabel('登录 URL').fill('http://127.0.0.1:45100/login');

  const loginWindowPromise = electronApp.waitForEvent('window');
  await page.getByRole('button', { name: '打开安全登录窗口' }).click();
  const loginWindow = await loginWindowPromise;
  await loginWindow.waitForLoadState('domcontentloaded');
  await expect(loginWindow.getByRole('heading', { name: 'Fixture 登录' })).toBeVisible();
  await loginWindow.getByRole('button', { name: '登录' }).click();
  await expect(loginWindow.getByRole('heading', { name: '登录后商品' })).toBeVisible();
  const closed = loginWindow.waitForEvent('close');
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().includes('/private-products'))
      ?.close();
  });
  await closed;

  await expect(page.getByText('登录态已安全保存')).toBeVisible();
  await expect(page.getByRole('button', { name: '重新登录' })).toBeVisible();
  await page.getByRole('button', { name: /分析网页/ }).click();
  await expect(page.getByRole('heading', { name: '提取规则' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '织云商品 01', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认并保存规则' }).click();
  await expect(page.getByText('规则版本已保存')).toBeVisible();
  await expect(page).toHaveURL(/tasks\/[^/]+\/edit/);
  const taskId = page.url().match(/tasks\/([^/]+)\/edit/)?.[1];
  expect(taskId).toBeTruthy();
  await page.goto(`app://zhiyun/tasks/${taskId}`);
  await page.getByRole('button', { name: '运行' }).click();
  await expect(page.locator('.page-heading .badge')).toHaveText('已完成', { timeout: 40_000 });
  await expect(page.getByRole('cell', { name: '织云商品 10', exact: true })).toBeVisible();
  await expect(page.getByText('Browser', { exact: true })).toBeVisible();
});

test('completes the unified offline example with draft recovery, responsive navigation and accessibility', async () => {
  await exerciseCollectionExperience(page, 'app://zhiyun');
  const exportPath = join(profile, 'offline-example.csv');
  await electronApp.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, exportPath);
  await page.getByText('导出', { exact: true }).click();
  await page.getByRole('button', { name: /CSV ·/ }).click();
  await expect
    .poll(async () => readFile(exportPath, 'utf8').catch(() => ''))
    .toContain('轻行双肩包');
});

test('keeps all core workspaces responsive and accessible', async () => {
  test.setTimeout(120_000);
  await exerciseWorkspaceLayouts(page, 'app://zhiyun');
});

test('creates a recruitment profile, imports a BOSS fixture and tracks workflow state', async () => {
  const suffix = Date.now();
  await page.goto('app://zhiyun/recruitment');
  await expect(page.getByRole('heading', { name: '职位雷达' })).toBeVisible();
  await page.getByLabel('档案名称').fill(`招聘 E2E ${suffix}`);
  await page.getByLabel('包含关键词').fill('TypeScript');
  await page.getByText('更多匹配条件、来源与通知（可稍后设置）', { exact: true }).click();
  await page.getByLabel('城市', { exact: true }).first().fill('上海');
  await page.getByRole('button', { name: '保存档案' }).click();
  await expect(page).toHaveURL(/\/recruitment\?profile=/);
  const createdRecruitmentProfileId = new URL(page.url()).searchParams.get('profile') ?? '';
  expect(createdRecruitmentProfileId).toBeTruthy();
  await page.getByRole('button', { name: '来源与通知', exact: true }).click();
  await expect(page.getByText('文件导入 / 原站跳转', { exact: true })).toHaveCount(3);
  await page.getByRole('button', { name: '导入职位', exact: true }).click();

  await page.getByRole('button', { name: '下一步' }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'boss-e2e.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      [
        '职位ID,职位名称,公司名称,职位链接,城市,薪资,职位描述,发布时间',
        `boss-e2e-${suffix},TypeScript E2E 工程师,织云测试有限公司,https://www.zhipin.com/job/e2e-${suffix},上海,20-30K,TypeScript 数据平台,2030-01-01`,
      ].join('\n'),
    ),
  });
  await page.getByRole('button', { name: '预览并识别字段' }).click();
  await expect(page.getByText(/识别到 1 行/)).toBeVisible();
  await page.getByRole('button', { name: '检查完成' }).click();
  await page.getByRole('button', { name: '开始导入' }).click();
  await expect(page.getByRole('link', { name: 'TypeScript E2E 工程师' })).toBeVisible();

  await page.getByRole('link', { name: 'TypeScript E2E 工程师' }).click();
  await expect(page.getByRole('heading', { name: 'TypeScript E2E 工程师' })).toBeVisible();
  await page.getByLabel('当前状态').selectOption('saved');
  await expect(page.getByLabel('当前状态')).toHaveValue('saved');
  await expect(page.getByRole('link', { name: '打开原职位 ↗' })).toHaveAttribute(
    'href',
    `https://www.zhipin.com/job/e2e-${suffix}`,
  );
});

test('instantiates an official template with an active rule without running it', async () => {
  await page.goto('app://zhiyun/tasks/new?professional=1');
  await page.getByRole('button', { name: /普通列表页/ }).click();
  await expect(page.getByText(/已加载官方模板“普通列表页”/)).toBeVisible();
  await page.getByLabel('任务名称').fill(`Template E2E ${Date.now()}`);
  await page.getByLabel('URL', { exact: true }).fill(`http://127.0.0.1:45100/products`);
  await page.getByLabel('记录容器选择器').fill('.product-card');
  await page.getByLabel('标题选择器').fill('.product-title');
  await page.getByLabel('链接选择器').fill('a.product-link');
  await page.getByText('高级设置').click();
  await page.getByLabel(/允许 localhost/).check();
  await page.getByRole('button', { name: '测试规则' }).click();
  await expect(page.getByRole('cell', { name: '织云商品 01', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认并保存规则' }).click();
  await expect(page.getByText('规则版本已保存')).toBeVisible();
  await expect(page).toHaveURL(/\/tasks\/[^/]+\/edit(?:\?.*)?$/);
  const match = page.url().match(/tasks\/([^/]+)\/edit/);
  expect(match?.[1]).toBeTruthy();
  const createdTaskId = match![1]!;
  await page.goto(`app://zhiyun/tasks/${createdTaskId}`);
  await expect(page.getByText(/来源：template · 活动规则 v1/)).toBeVisible();
  await expect(page.getByText(`http://127.0.0.1:45100/products`, { exact: true })).toBeVisible();
});

test('stops Infinite Scroll after the dynamic fixture is exhausted', async () => {
  await page.goto('app://zhiyun/tasks/new?professional=1');
  await page.getByLabel('任务名称').fill(`Infinite E2E ${Date.now()}`);
  await page.getByLabel('URL').fill(`http://127.0.0.1:45100/dynamic-products`);
  await page.getByText('高级设置').click();
  await page.getByLabel(/允许 localhost/).check();
  await page.getByLabel('使用浏览器').check();
  await page.getByLabel('分页方式').selectOption('infinite');
  await page.getByRole('button', { name: /分析网页/ }).click();

  await expect(page.getByRole('heading', { name: '提取规则' })).toBeVisible();
  await page.getByRole('button', { name: '确认并保存规则' }).click();
  await expect(page.getByText('规则版本已保存')).toBeVisible();
  await expect(page).toHaveURL(/\/tasks\/[^/]+\/edit(?:\?.*)?$/);
  const match = page.url().match(/tasks\/([^/]+)\/edit/);
  expect(match?.[1]).toBeTruthy();
  const createdTaskId = match![1]!;
  await page.goto(`app://zhiyun/tasks/${createdTaskId}`);
  await page.getByRole('button', { name: '运行' }).click();
  await expect(page.locator('.page-heading .badge')).toHaveText('已完成', { timeout: 40_000 });
  await expect(page.getByRole('cell', { name: '织云商品 30', exact: true })).toBeVisible();
  await expect(page.getByText('30', { exact: true }).first()).toBeVisible();
});
