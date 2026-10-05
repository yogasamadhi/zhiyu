import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import type {
  RuntimeBootstrap,
  RuleRecord,
  RuleVersionRecord,
  RuleRepairProposal,
} from '@zhiyun/contracts';
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
      if (!session.ok) throw new Error(`Rule history session HTTP ${session.status}`);
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
      if (!response.ok) throw new Error(`Rule history ${path}: HTTP ${response.status}`);
      return response.json();
    },
    { path, body, key: randomUUID() },
  ) as Promise<T>;
}

type RuleWithVersions = RuleRecord & { versions: RuleVersionRecord[] };

test('professional rule history compares, rolls back, tests and reviews Mock repairs without mutating old versions', async ({
  browserName,
}, info) => {
  void browserName;
  test.setTimeout(120000);
  const profile = await mkdtemp(join(tmpdir(), 'zy-rule-history-e2e-'));
  console.info('RULE_HISTORY_PROFILE', profile);
  const source = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(
      '<!doctype html><main><article class="product-card"><h2 class="title">First fixture</h2><span class="price">12</span></article><article class="product-card"><h2 class="title">Second fixture</h2><span class="price">24</span></article></main>',
    );
  });
  let app: ElectronApplication | undefined;
  try {
    await new Promise<void>((done) => source.listen(0, '127.0.0.1', done));
    const address = source.address();
    if (!address || typeof address === 'string')
      throw new Error('Owned history source did not bind');
    const desktopRoot = resolve(import.meta.dirname, '..');
    app = await electron.launch({
      args: [desktopRoot, `--user-data-dir=${profile}`],
      cwd: desktopRoot,
      env: { ...testEnvironment(process.env), TMPDIR: profile, TMP: profile, TEMP: profile },
      timeout: 30000,
    });
    const page = await app.firstWindow({ timeout: 30000 });
    page.on('pageerror', (error) => console.info('RULE_HISTORY_PAGE_ERROR', error.message));
    page.setDefaultTimeout(15000);
    await expect(page.getByRole('heading', { name: '首页', exact: true })).toBeVisible();
    const windowPromptBehavior = await page.evaluate(() => {
      try {
        window.prompt('Owned rule-history capability probe');
        return 'supported';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });
    console.info('RULE_HISTORY_WINDOW_PROMPT', windowPromptBehavior);
    const task = await request<{ id: string }>(page, '/api/v2/tasks', {
      name: 'Owned rule history fixture',
      startUrl: `http://127.0.0.1:${address.port}/`,
      instruction: 'Collect name price',
      browserSettings: { enabled: false },
      networkPolicy: { allowPrivateNetworks: true },
      requestSettings: { respectRobotsTxt: false, delayMs: 0, retries: 0, maxRequests: 1 },
    });
    const definition = {
      list: {
        mode: 'http',
        rule: {
          type: 'css',
          container: '.product-card',
          fields: {
            name: { selector: '.old-title', value: 'text', dataType: 'string' },
            price: { selector: '.price', value: 'text', dataType: 'number' },
          },
        },
      },
      pagination: { type: 'none' },
    };
    const created = await request<{ rule: RuleRecord; version: RuleVersionRecord }>(
      page,
      `/api/v2/tasks/${task.id}/rules`,
      { name: 'History fixture', generatedBy: 'human', definition },
    );
    const root = `/api/v2/tasks/${task.id}/rules/${created.rule.id}`;
    const secondDefinition = structuredClone(definition);
    secondDefinition.list.rule.fields.name.selector = '.title';
    await request(page, `${root}/versions`, { definition: secondDefinition, generatedBy: 'human' });
    const original = (
      await request<RuleWithVersions[]>(page, `/api/v2/tasks/${task.id}/rules`)
    )[0]!;
    expect(original.versions).toHaveLength(2);

    await page.goto(`app://zhiyun/tasks/${task.id}/edit?professional=1`);
    const history = page
      .locator('section.card')
      .filter({ has: page.getByRole('heading', { name: /RuleVersion 历史/ }) });
    await expect(history).toBeVisible();
    const waitMutation = (suffix: string) =>
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === root + suffix &&
          response.request().method() === 'POST',
      );
    const diffResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === root + '/diff',
    );
    await history.getByRole('button', { name: '比较版本', exact: true }).click();
    expect((await diffResponse).status()).toBe(200);
    await expect(history.locator('.diff-view')).toContainText('/list/rule/fields/name/selector');
    await expect(history.locator('.diff-view')).toContainText('.old-title');
    await expect(history.locator('.diff-view')).toContainText('.title');
    const rollbackResponse = waitMutation('/rollback');
    await history
      .locator('.version-item')
      .filter({ has: page.getByText('v1', { exact: true }) })
      .getByRole('button', { name: '回滚到此版本' })
      .click();
    expect((await rollbackResponse).status()).toBe(201);
    await expect
      .poll(
        async () =>
          (await request<RuleWithVersions[]>(page, `/api/v2/tasks/${task.id}/rules`))[0]!.versions
            .length,
      )
      .toBe(3);
    const rolledBack = (
      await request<RuleWithVersions[]>(page, `/api/v2/tasks/${task.id}/rules`)
    )[0]!;
    const active = rolledBack.versions.find(
      (version) => version.id === rolledBack.activeVersionId,
    )!;
    expect(active.version).toBe(3);
    expect(active.definition.list.rule.fields.name).toMatchObject({ selector: '.old-title' });
    expect(rolledBack.versions.filter((version) => version.version <= 2)).toEqual(
      original.versions,
    );

    await history.getByRole('button', { name: 'AI 修复建议', exact: true }).click();
    await info.attach('repair-request-form.html', {
      body: await history.innerHTML(),
      contentType: 'text/html',
    });
    await history.getByLabel('规则失败现象', { exact: true }).fill('  ');
    await expect(history.getByRole('button', { name: '生成修复建议', exact: true })).toBeDisabled();
    await history.getByRole('button', { name: '取消', exact: true }).click();
    await expect(history.getByLabel('规则失败现象', { exact: true })).toHaveCount(0);
    expect(await request<RuleRepairProposal[]>(page, root + '/repair-proposals')).toEqual([]);
    const propose = async () => {
      await history.getByRole('button', { name: 'AI 修复建议', exact: true }).click();
      await history
        .getByLabel('规则失败现象', { exact: true })
        .fill('Fixture title selector moved');
      const proposedResponse = waitMutation('/repair-proposals');
      await history.getByRole('button', { name: '生成修复建议', exact: true }).click();
      const response = await proposedResponse;
      expect(response.status()).toBe(201);
      return (await response.json()) as RuleRepairProposal;
    };
    const proposal = await propose();
    const apply = history.getByRole('button', { name: '确认应用', exact: true });
    await expect(apply).toBeDisabled();
    expect(
      (await request<RuleWithVersions[]>(page, `/api/v2/tasks/${task.id}/rules`))[0]!
        .activeVersionId,
    ).toBe(active.id);
    await history.getByRole('button', { name: '查看 Diff', exact: true }).click();
    await expect(history.locator('.repair-list .diff-view')).toContainText('.old-title');
    await expect(history.locator('.repair-list .diff-view')).toContainText('.title');
    const testedResponse = waitMutation(`/repair-proposals/${proposal.id}/test`);
    await history.getByRole('button', { name: '测试', exact: true }).click();
    const tested = await testedResponse;
    expect(tested.status()).toBe(200);
    const testedBody = (await tested.json()) as {
      records: Array<{ data: { name: string; price: number } }>;
    };
    expect(testedBody.records.map((record) => record.data)).toEqual([
      { name: 'First fixture', price: 12 },
      { name: 'Second fixture', price: 24 },
    ]);
    await expect(apply).toBeEnabled();
    const appliedResponse = waitMutation(`/repair-proposals/${proposal.id}/apply`);
    await apply.click();
    expect((await appliedResponse).status()).toBe(201);
    const repaired = (
      await request<RuleWithVersions[]>(page, `/api/v2/tasks/${task.id}/rules`)
    )[0]!;
    expect(repaired.versions).toHaveLength(4);
    expect(repaired.versions.filter((version) => version.version <= 3)).toEqual(
      rolledBack.versions,
    );
    const repairedVersion = repaired.versions.find(
      (version) => version.id === repaired.activeVersionId,
    )!;
    expect(repairedVersion.version).toBe(4);
    expect(repairedVersion.definition.list.rule.fields.name).toMatchObject({ selector: '.title' });
    await page.reload();
    await expect(history.getByText('v4', { exact: true })).toBeVisible();
    const rejected = await propose();
    const rejectedResponse = waitMutation(`/repair-proposals/${rejected.id}/reject`);
    await history.getByRole('button', { name: '拒绝', exact: true }).click();
    expect((await rejectedResponse).status()).toBe(200);
    const afterReject = (
      await request<RuleWithVersions[]>(page, `/api/v2/tasks/${task.id}/rules`)
    )[0]!;
    expect(afterReject).toEqual(repaired);
    const proposals = await request<RuleRepairProposal[]>(page, root + '/repair-proposals');
    expect(proposals.find((item) => item.id === proposal.id)?.status).toBe('applied');
    expect(proposals.find((item) => item.id === rejected.id)?.status).toBe('rejected');
    await info.attach('rule-history.json', {
      body: JSON.stringify({
        provider: 'Mock',
        windowPromptBehavior,
        preservedOriginalVersions: original.versions.map((version) => version.id),
        rollbackVersion: active.version,
        repairVersion: repairedVersion.version,
        previewRecords: testedBody.records.length,
        applyRequiredTest: true,
        rejectedProposalPreservedActiveVersion: true,
      }),
      contentType: 'application/json',
    });
  } finally {
    try {
      if (app) await app.close();
    } finally {
      await rm(profile, { recursive: true, force: true });
      if (source.listening)
        await new Promise<void>((done, reject) =>
          source.close((error) => (error ? reject(error) : done())),
        );
    }
  }
});
