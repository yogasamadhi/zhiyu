import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  CrawlRun,
  MonitoringAlertPage,
  MonitoringAlertRunPage,
  QualityEvaluation,
  QualityPolicy,
  RuntimeBootstrap,
} from '@zhiyun/contracts';
import { testEnvironment } from '../../tooling/scripts/test-environment.js';

type Kind = 'field-value-change' | 'record-count-drop' | 'null-rate-spike';
const labels: Record<Kind, string> = {
  'field-value-change': '字段值变化',
  'record-count-drop': '记录数骤降',
  'null-rate-spike': '空值率骤升',
};

async function request<T>(
  page: Page,
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  return page.evaluate(
    async ({ path, body, key, method }) => {
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
        method,
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
    { path, body, method, key: randomUUID() },
  ) as Promise<T>;
}

function events(profile: string) {
  // The only database read here belongs to this fresh, temporary Electron profile.
  const database = new DatabaseSync(join(profile, 'zhiyun.sqlite3'), { readOnly: true });
  try {
    return database
      .prepare(
        "SELECT type,payload FROM platform_events WHERE type LIKE 'monitoring.%' OR type LIKE 'quality.%' ORDER BY cursor",
      )
      .all()
      .map((row) => ({
        type: String(row.type),
        payload: JSON.parse(String(row.payload)) as Record<string, unknown>,
      }));
  } finally {
    database.close();
  }
}

test('desktop monitoring configures three conditions, traces events, survives native refusal and resumes once', async ({
  browserName,
}, info) => {
  void browserName;
  test.setTimeout(240_000);
  const profile = await mkdtemp(join(tmpdir(), 'zy-monitoring-e2e-'));
  console.info('MONITORING_PROFILE', profile);
  const levels: Record<string, number> = {};
  let generation = 0;
  const source = createServer((incoming, response) => {
    const kind = incoming.url?.slice(1) ?? '';
    const level = levels[kind] ?? 0;
    generation += 1;
    const rows = Array.from(
      { length: kind === 'record-count-drop' ? 20 - level : 20 },
      (_, index) => ({
        id: index,
        price:
          kind === 'null-rate-spike' && index < level
            ? null
            : kind === 'field-value-change'
              ? index + level
              : index,
        secret: `OPT09_PRIVATE_${generation}_${index}`,
      }),
    );
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
    page.on('pageerror', (error) => console.info('MONITORING_PAGE_ERROR', error.message));
    await expect(page.getByRole('heading', { name: '首页', exact: true })).toBeVisible();
    // Patch only this owned Main process. No real OS notification or permission change occurs.
    await app.evaluate(({ Notification }) => {
      const state = globalThis as typeof globalThis & {
        monitoringNativeMessages?: Array<{ title: string; body: string }>;
      };
      state.monitoringNativeMessages = [];
      Notification.isSupported = () => true;
      Notification.prototype.show = function () {
        state.monitoringNativeMessages!.push({ title: this.title, body: this.body });
        this.emit('failed', {}, 'Owned notification refusal');
      };
    });
    const createTask = async (
      name: string,
      route: string,
      schedule?: {
        mode: 'cron';
        cron: string;
        timezone: string;
        misfirePolicy: 'skip' | 'run-once';
      },
    ) => {
      const task = await request<{ id: string }>(page, '/api/v2/tasks', {
        name,
        startUrl: `http://127.0.0.1:${address.port}/${route}`,
        instruction: 'Read owned local JSON',
        browserSettings: { enabled: false },
        networkPolicy: { allowPrivateNetworks: true },
        requestSettings: {
          retries: 0,
          concurrency: 1,
          delayMs: 0,
          maxRequests: 1,
          respectRobotsTxt: false,
        },
        datasetSettings: { mode: 'snapshot', keyFields: ['id'], detectRemoved: true },
        ...(schedule ? { schedule } : {}),
      });
      await request(page, `/api/v2/tasks/${task.id}/rules`, {
        name: 'Owned JSON monitoring rule',
        generatedBy: 'human',
        definition: {
          list: {
            mode: 'http',
            rule: {
              type: 'json',
              container: '$.items[*]',
              fields: Object.fromEntries(
                ['id', 'price', 'secret'].map((field) => [
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
      return task.id;
    };
    const waitSucceeded = async (runId: string) => {
      await expect
        .poll(
          async () => {
            const run = await request<CrawlRun>(page, `/api/v2/runs/${runId}`);
            if (['failed', 'canceled'].includes(run.status))
              throw new Error(`Owned Run ${run.status}: ${run.error}`);
            return run.status;
          },
          { timeout: 30_000, intervals: [100, 250, 500] },
        )
        .toBe('succeeded');
    };
    const evidence = [];
    for (const kind of Object.keys(labels) as Kind[]) {
      const notificationStatus = kind === 'null-rate-spike' ? 'unsupported' : 'failed';
      await app.evaluate(({ Notification }, supported) => {
        Notification.isSupported = () => supported;
      }, notificationStatus !== 'unsupported');
      const taskId = await createTask(`OPT09 ${labels[kind]}`, kind);
      await page.goto(`app://zhiyun/tasks/${taskId}/quality`);
      await expect(page.getByRole('heading', { name: '质量策略', exact: true })).toBeVisible();
      const editor = page.locator('.monitoring-editor');
      await editor.getByLabel('基线运行次数', { exact: true }).fill('1');
      await editor.getByLabel('最少基线运行次数', { exact: true }).fill('1');
      const old = editor.locator('details');
      await old.locator('summary').click();
      for (const checkbox of await old.getByRole('checkbox').all())
        await checkbox.setChecked(false);
      for (const candidate of Object.keys(labels) as Kind[])
        await editor
          .getByRole('group', { name: labels[candidate], exact: true })
          .getByLabel('启用此条件', { exact: true })
          .setChecked(candidate === kind);
      const group = editor.getByRole('group', { name: labels[kind], exact: true });
      if (kind === 'null-rate-spike')
        await expect(group.getByLabel('阈值单位', { exact: true })).toHaveValue('legacy');
      await group.getByRole('button', { name: '使用此条件默认值', exact: true }).click();
      await expect(group.getByLabel('冷却时间（秒）', { exact: true })).toHaveValue('300');
      await expect(group.getByLabel('聚合窗口（秒）', { exact: true })).toHaveValue('3600');
      await group
        .getByLabel('阈值单位', { exact: true })
        .selectOption(kind === 'record-count-drop' ? 'absolute' : 'percentage');
      await group
        .getByLabel('触发阈值', { exact: true })
        .fill(kind === 'record-count-drop' ? '4' : kind === 'field-value-change' ? '50' : '10');
      await group.getByLabel('连续异常次数', { exact: true }).fill('2');
      await group.getByLabel('冷却时间（秒）', { exact: true }).fill('60');
      if (kind !== 'record-count-drop') {
        await group.getByLabel('包含字段', { exact: true }).selectOption(['price', 'secret']);
        await group.getByLabel('排除字段', { exact: true }).selectOption(['secret']);
        await expect(group.getByLabel('条件预览', { exact: true })).toContainText('排除： secret');
      }
      const save = editor.getByRole('button', { name: '保存监控策略', exact: true });
      await group.getByLabel('连续异常次数', { exact: true }).fill('0');
      await expect(save).toBeDisabled();
      await group.getByLabel('连续异常次数', { exact: true }).fill('2');
      await save.click();
      await expect(save).toBeDisabled();
      const policy = await request<QualityPolicy>(page, `/api/v2/tasks/${taskId}/quality-policy`);
      expect(policy.rules.filter((rule) => rule.enabled)).toEqual([
        expect.objectContaining({
          kind,
          threshold: kind === 'record-count-drop' ? 4 : kind === 'field-value-change' ? 0.5 : 0.1,
          thresholdMode: kind === 'record-count-drop' ? 'absolute' : 'percentage',
          consecutiveRuns: 2,
          cooldownSeconds: 60,
          aggregationSeconds: 3600,
          ...(kind === 'record-count-drop'
            ? { fields: [] }
            : { fields: ['price', 'secret'], excludeFields: ['secret'] }),
        }),
      ]);
      const collect = async (level: number, fromUi = true) => {
        levels[kind] = level;
        let runId: string;
        if (fromUi) {
          await page.goto(`app://zhiyun/tasks/${taskId}/quality`);
          await page.getByRole('button', { name: '运行', exact: true }).click();
          await expect(page).toHaveURL(/\/runs\/[0-9a-f-]+$/);
          runId = page.url().split('/').at(-1)!;
        } else {
          ({ runId } = await request<{ runId: string }>(page, `/api/v2/tasks/${taskId}/runs`, {}));
        }
        await waitSucceeded(runId);
        let evaluation: QualityEvaluation | undefined;
        await expect
          .poll(async () => {
            evaluation = (
              await request<QualityEvaluation[]>(
                page,
                `/api/v2/tasks/${taskId}/quality-evaluations`,
              )
            ).find((item) => item.runId === runId);
            return Boolean(evaluation);
          })
          .toBe(true);
        return { runId, evaluation: evaluation! };
      };
      const initial = await collect(0);
      const values =
        kind === 'record-count-drop'
          ? [1, 5, 10, 15]
          : kind === 'null-rate-spike'
            ? [1, 4, 7, 10]
            : [0, 1, 2, 3];
      const normal = await collect(values[0]!);
      expect(normal.evaluation.issues).toEqual([]);
      const first = await collect(values[1]!);
      expect(first.evaluation.issues.map((issue) => issue.kind)).toEqual([kind]);
      const second = await collect(values[2]!);
      const third = await collect(values[3]!);
      let alerts = await request<MonitoringAlertPage>(
        page,
        `/api/v2/tasks/${taskId}/monitoring-alerts`,
      );
      expect(alerts.items).toHaveLength(1);
      const alert = alerts.items[0]!;
      expect(alert).toMatchObject({
        occurrenceCount: 3,
        notificationCount: 1,
        suppressedCount: 2,
        status: 'open',
        firstRunId: first.runId,
        lastRunId: third.runId,
      });
      const runs = await request<MonitoringAlertRunPage>(
        page,
        `/api/v2/tasks/${taskId}/monitoring-alerts/${alert.id}/runs`,
      );
      expect(runs.items.map((item) => [item.runId, item.reason])).toEqual([
        [third.runId, 'cooldown'],
        [second.runId, 'ready'],
        [first.runId, 'consecutive'],
      ]);
      await expect
        .poll(() =>
          events(profile)
            .filter(
              (event) =>
                event.type === 'monitoring.notification.local' &&
                event.payload.runId === second.runId,
            )
            .map((event) => event.payload.status),
        )
        .toEqual([notificationStatus]);
      await page.goto(`app://zhiyun/tasks/${taskId}/quality`);
      const eventPanel = page.getByLabel('监控事件', { exact: true });
      await expect(eventPanel).toContainText('异常次数 3');
      await eventPanel.getByRole('button', { name: '查看运行记录', exact: true }).click();
      const trace = eventPanel.getByLabel('事件运行记录', { exact: true });
      await expect(trace.locator('tbody tr')).toHaveCount(3);
      await trace.getByRole('link', { name: second.runId, exact: true }).click();
      await expect(page).toHaveURL(`app://zhiyun/runs/${second.runId}`);
      const anomalies = [first, second, third];
      let recoveryLevel = kind === 'field-value-change' ? values[3]! : 0;
      if (kind === 'field-value-change') {
        for (let level = 4; level <= 24; level += 1) anomalies.push(await collect(level, false));
        recoveryLevel = 24;
        await page.goto(`app://zhiyun/tasks/${taskId}/quality`);
        const pagedPanel = page.getByLabel('监控事件', { exact: true });
        await expect(pagedPanel).toContainText('异常次数 24');
        await pagedPanel.getByRole('button', { name: '查看运行记录', exact: true }).click();
        const pagedTrace = pagedPanel.getByLabel('事件运行记录', { exact: true });
        await expect(pagedTrace.locator('tbody tr')).toHaveCount(20);
        const firstPage = await pagedTrace.locator('tbody a').allTextContents();
        await pagedTrace.getByRole('button', { name: '下一页', exact: true }).click();
        await expect(pagedTrace.locator('tbody tr')).toHaveCount(4);
        const secondPage = await pagedTrace.locator('tbody a').allTextContents();
        expect([...firstPage, ...secondPage]).toEqual(anomalies.map((run) => run.runId).reverse());
        await expect(
          pagedTrace.getByRole('button', { name: '下一页', exact: true }),
        ).toBeDisabled();
        await pagedTrace.getByRole('button', { name: '上一页', exact: true }).click();
        await expect(pagedTrace.locator('tbody tr')).toHaveCount(20);
        expect(await pagedTrace.locator('tbody a').allTextContents()).toEqual(firstPage);
      }
      const recovery = await collect(recoveryLevel);
      expect(recovery.evaluation.issues).toEqual([]);
      alerts = await request<MonitoringAlertPage>(
        page,
        `/api/v2/tasks/${taskId}/monitoring-alerts`,
      );
      expect(alerts.items[0]!.status).toBe('resolved');
      await page.goto(`app://zhiyun/tasks/${taskId}/quality`);
      const resolvedPanel = page.getByLabel('监控事件', { exact: true });
      await expect(resolvedPanel).toContainText('已恢复');
      await resolvedPanel.getByRole('button', { name: '关闭此事件', exact: true }).click();
      await expect(resolvedPanel).toContainText('已关闭');
      await resolvedPanel.getByRole('button', { name: '查看运行记录', exact: true }).click();
      await expect(resolvedPanel.locator('tbody tr')).toHaveCount(Math.min(anomalies.length, 20));
      const taskEvents = events(profile).filter((event) => event.payload.taskId === taskId);
      expect(
        taskEvents
          .filter((event) => event.type === 'monitoring.alert.created')
          .map((event) => event.payload.runId),
      ).toEqual([first.runId]);
      expect(
        taskEvents
          .filter((event) => event.type === 'monitoring.alert.updated')
          .map((event) => event.payload.runId),
      ).toEqual(anomalies.slice(1).map((run) => run.runId));
      expect(
        taskEvents
          .filter((event) => event.type === 'monitoring.alert.resolved')
          .map((event) => event.payload.runId),
      ).toEqual([recovery.runId]);
      expect(
        taskEvents
          .filter((event) => event.type === 'monitoring.alert.deleted')
          .map((event) => event.payload.runId),
      ).toEqual([anomalies.at(-1)!.runId]);
      const database = new DatabaseSync(join(profile, 'zhiyun.sqlite3'), { readOnly: true });
      try {
        const changeTypes = database
          .prepare(
            'SELECT DISTINCT type FROM record_changes WHERE source_run_id IN (?,?,?) ORDER BY type',
          )
          .all(initial.runId, third.runId, recovery.runId)
          .map((row) => String(row.type));
        expect(changeTypes).toContain('updated');
        expect(changeTypes).toContain('added');
        if (kind === 'record-count-drop') expect(changeTypes).toContain('removed');
      } finally {
        database.close();
      }
      evidence.push({
        kind,
        taskId,
        alertId: alert.id,
        anomalyRuns: anomalies.map((run) => run.runId).reverse(),
        recoveryRunId: recovery.runId,
        notificationStatus,
      });
    }

    const fieldTaskId = evidence[0]!.taskId;
    const fieldPolicy = await request<QualityPolicy>(
      page,
      `/api/v2/tasks/${fieldTaskId}/quality-policy`,
    );
    await request(
      page,
      `/api/v2/tasks/${fieldTaskId}/quality-policy`,
      {
        ...fieldPolicy,
        rules: fieldPolicy.rules.map((rule) =>
          rule.kind === 'field-value-change'
            ? { ...rule, consecutiveRuns: 1, aggregationSeconds: 0 }
            : rule,
        ),
      },
      'PUT',
    );
    for (let level = 30; level < 42; level += 1) {
      levels['field-value-change'] = level;
      const { runId } = await request<{ runId: string }>(
        page,
        `/api/v2/tasks/${fieldTaskId}/runs`,
        {},
      );
      await waitSucceeded(runId);
      await expect
        .poll(async () =>
          (
            await request<QualityEvaluation[]>(
              page,
              `/api/v2/tasks/${fieldTaskId}/quality-evaluations`,
            )
          ).some((evaluation) => evaluation.runId === runId),
        )
        .toBe(true);
    }
    const completeAlerts = await request<MonitoringAlertPage>(
      page,
      `/api/v2/tasks/${fieldTaskId}/monitoring-alerts?limit=50`,
    );
    expect(completeAlerts.items).toHaveLength(13);
    await page.goto(`app://zhiyun/tasks/${fieldTaskId}/quality`);
    const pagedEvents = page.getByLabel('监控事件', { exact: true });
    const visibleFirstRuns = () =>
      pagedEvents
        .locator('article')
        .evaluateAll((articles) =>
          articles.map((article) =>
            article.querySelector('a')?.getAttribute('href')?.split('/').at(-1),
          ),
        );
    await expect(pagedEvents.locator('article')).toHaveCount(10);
    const firstAlertPage = await visibleFirstRuns();
    expect(firstAlertPage).toEqual(
      completeAlerts.items.slice(0, 10).map((alert) => alert.firstRunId),
    );
    await pagedEvents.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(pagedEvents.locator('article')).toHaveCount(3);
    expect([...firstAlertPage, ...(await visibleFirstRuns())]).toEqual(
      completeAlerts.items.map((alert) => alert.firstRunId),
    );
    await expect(pagedEvents.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
    await pagedEvents.getByRole('button', { name: '上一页', exact: true }).click();
    await expect(pagedEvents.locator('article')).toHaveCount(10);
    expect(await visibleFirstRuns()).toEqual(firstAlertPage);
    await page.goto(`app://zhiyun/tasks/${evidence.at(-1)!.taskId}/quality`);
    await page
      .getByLabel('监控事件', { exact: true })
      .getByRole('button', { name: '查看运行记录', exact: true })
      .click();

    await page.setViewportSize({ width: 360, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: info.outputPath('monitoring-zh-360.png'), fullPage: true });
    await page
      .getByLabel('监控事件', { exact: true })
      .screenshot({ path: info.outputPath('monitoring-events-zh-360.png') });
    await page
      .getByRole('group', { name: '空值率骤升', exact: true })
      .screenshot({ path: info.outputPath('monitoring-condition-zh-360.png') });
    await page.locator('.mobile-topbar button[aria-controls="workspace-navigation"]').click();
    await page.locator('.language-button').click();
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('heading', { name: 'Monitoring events', exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    const englishEvents = page.getByLabel('Monitoring events', { exact: true });
    await expect(englishEvents).toContainText('Closed');
    await expect(englishEvents).toContainText('First occurrence');
    await expect(englishEvents.getByRole('button', { name: 'Next page', exact: true })).toHaveCount(
      2,
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: info.outputPath('monitoring-en-360.png'), fullPage: true });
    await page
      .getByLabel('Monitoring events', { exact: true })
      .screenshot({ path: info.outputPath('monitoring-events-en-360.png') });
    await englishEvents.evaluate((element) =>
      window.scrollTo(0, window.scrollY + element.getBoundingClientRect().top - 90),
    );
    await page.screenshot({ path: info.outputPath('monitoring-events-en-viewport-360.png') });
    const nativeMessages = await app.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            monitoringNativeMessages: Array<{ title: string; body: string }>;
          }
        ).monitoringNativeMessages,
    );
    expect(nativeMessages.length).toBeGreaterThanOrEqual(3);
    const safeNotifications = JSON.stringify({ nativeMessages, events: events(profile) });
    for (const sensitive of ['OPT09_PRIVATE', 'price', 'secret', 'Owned notification refusal'])
      expect(safeNotifications).not.toContain(sensitive);

    // Real Main lifecycle -> utility IPC -> existing scheduler, while the OS stays online/awake.
    await app.evaluate(({ net, powerMonitor }) => {
      net.isOnline = () => false;
      powerMonitor.emit('suspend');
    });
    const due = Math.ceil((Date.now() + 8_000) / 60_000) * 60_000;
    const cron = `${new Date(due).getUTCMinutes()} * * * *`;
    const skipped = await createTask('OPT09 scheduled skip', 'schedule-skip', {
      mode: 'cron',
      cron,
      timezone: 'UTC',
      misfirePolicy: 'skip',
    });
    const once = await createTask('OPT09 scheduled run once', 'schedule-once', {
      mode: 'cron',
      cron,
      timezone: 'UTC',
      misfirePolicy: 'run-once',
    });
    const listRuns = (taskId: string) =>
      request<{ items: CrawlRun[] }>(page, `/api/v2/tasks/${taskId}/runs`);
    while (Date.now() < due + 1000)
      await page.waitForTimeout(Math.min(1000, due + 1000 - Date.now()));
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
    await page.waitForTimeout(5500);
    expect((await listRuns(skipped)).items).toEqual([]);
    expect((await listRuns(once)).items).toEqual([]);
    await app.evaluate(({ net, powerMonitor }) => {
      net.isOnline = () => true;
      powerMonitor.emit('resume');
    });
    let resumedRun: CrawlRun | undefined;
    await expect
      .poll(
        async () => {
          const runs = (await listRuns(once)).items;
          expect(runs).toHaveLength(runs.length === 0 ? 0 : 1);
          resumedRun = runs[0];
          return resumedRun?.status;
        },
        { timeout: 30_000 },
      )
      .toBe('succeeded');
    expect(resumedRun!.metadata).toMatchObject({ scheduled: true, misfire: true });
    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit('resume');
      powerMonitor.emit('resume');
    });
    await page.waitForTimeout(5500);
    expect((await listRuns(skipped)).items).toEqual([]);
    expect((await listRuns(once)).items.map((run) => run.id)).toEqual([resumedRun!.id]);
    const finalDatabase = new DatabaseSync(join(profile, 'zhiyun.sqlite3'), { readOnly: true });
    let actualSuccessfulRuns: number;
    try {
      actualSuccessfulRuns = Number(
        finalDatabase.prepare("SELECT COUNT(*) AS count FROM runs WHERE status='succeeded'").get()!
          .count,
      );
      expect(actualSuccessfulRuns).toBe(52);
      expect(
        finalDatabase.prepare('SELECT COUNT(*) AS count FROM delivery_attempts').get()!.count,
      ).toBe(0);
    } finally {
      finalDatabase.close();
    }
    const evidencePath = info.outputPath('monitoring-desktop-v1.json');
    await writeFile(
      evidencePath,
      JSON.stringify(
        {
          fixtureVersion: 'monitoring-desktop-v1',
          rules: evidence,
          nativeMessageCount: nativeMessages.length,
          nativeRefusalDoesNotFailRun: true,
          includeExcludeVerified: true,
          historyPreservedAfterDismiss: true,
          eventListPages: [10, 3],
          eventRunPages: [20, 4],
          actualSuccessfulRuns,
          externalDeliveryAttempts: 0,
          actualMainLifecycleIpc: true,
          missedCronAt: new Date(due).toISOString(),
          skipRuns: 0,
          runOnceRunId: resumedRun!.id,
          repeatedResumeRuns: 1,
          mobileNoOverflow: ['zh', 'en'],
        },
        null,
        2,
      ) + '\n',
    );
    await info.attach('monitoring-desktop-v1.json', {
      path: evidencePath,
      contentType: 'application/json',
    });
  } finally {
    try {
      await app?.close();
    } finally {
      source.closeAllConnections();
      if (source.listening) await new Promise<void>((done) => source.close(() => done()));
      await rm(profile, { recursive: true, force: true });
      console.info('MONITORING_STAGE', 'host, fixture and owned profile removed');
    }
  }
});
