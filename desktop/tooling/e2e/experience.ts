import { expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

export async function exerciseCollectionExperience(page: Page, prefix = '') {
  await page.goto(`${prefix}/tasks/new`);
  await page.getByRole('button', { name: '使用商品样例', exact: true }).click();
  await expect(page.getByText('内置商品样例 · 可离线运行')).toBeVisible();
  const draftUrl = page.url();
  // Re-entering the creation flow after the blank draft was replaced must work.
  await page.goto(`${prefix}/tasks/new`);
  await expect(page.getByRole('button', { name: '使用商品样例', exact: true })).toBeVisible();
  await page.goto(draftUrl);
  await page.reload();
  await expect(page.getByText('内置商品样例 · 可离线运行')).toBeVisible();
  expect(page.url()).toBe(draftUrl);
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: '预览数据', exact: true }).click();
  await expect(page.getByRole('cell', { name: '轻行双肩包', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: '保存并运行', exact: true }).click();
  await expect(page.getByRole('heading', { name: '任务已保存', exact: true })).toBeVisible();
  const resultLink = page.getByRole('link', { name: '查看任务与结果' });
  const taskId = (await resultLink.getAttribute('href'))!.split('/')[2]!;
  await resultLink.click();
  await expect(page.getByText('已完成', { exact: true }).first()).toBeVisible({ timeout: 30000 });
  await page.goto(`${prefix}/tasks/${taskId}/dataset`);
  await expect(page.getByRole('cell', { name: '轻行双肩包', exact: true })).toBeVisible();
  for (const width of [360, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.setViewportSize({ width: 360, height: 900 });
  const navigation = page.getByRole('button', { name: '打开导航' });
  await navigation.click();
  await expect(page.locator('.sidebar-footer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(navigation).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
  const accessibility = await new AxeBuilder({ page })
    .setLegacyMode(prefix.startsWith('app:'))
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(
    accessibility.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target) })),
  ).toEqual([]);
  await page.locator('.language-button').click();
  await expect(page.getByRole('link', { name: 'Datasets', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Home', exact: true }).first()).toBeVisible();
  await page.locator('.language-button').click();
  if (!prefix) {
    const downloaded = page.waitForEvent('download');
    await page.getByText('导出', { exact: true }).click();
    await page.getByRole('button', { name: /CSV ·/ }).click();
    expect((await downloaded).suggestedFilename()).toMatch(/\.csv$/);
  }
  await page.goto(`${prefix}/tasks/new`);
  await expect(page.getByRole('button', { name: '使用商品样例', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '任务已保存', exact: true })).toHaveCount(0);
  await page.goto(`${prefix}/tasks/${taskId}/dataset`);
  await expect(page.getByRole('cell', { name: '轻行双肩包', exact: true })).toBeVisible();
  return taskId;
}

export async function exerciseWorkspaceLayouts(page: Page, prefix = '') {
  for (const route of [
    '/tasks',
    '/datasets',
    '/analytics',
    '/outputs',
    '/scenarios',
    '/settings',
    '/recruitment',
    '/preferences',
  ]) {
    await page.goto(`${prefix}${route}`);
    await expect(page.locator('main h1')).toBeVisible();
    for (const width of [360, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), {
          message: `${route} at ${width}px`,
        })
        .toBe(true);
    }
    if (route === '/outputs') {
      await page.getByRole('button', { name: '数据同步', exact: true }).click();
      const add = page.getByRole('button', { name: '新增连接', exact: true });
      await add.click();
      const dialog = page.getByRole('dialog', { name: '新增连接', exact: true });
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(add).toBeFocused();
    }
    const result = await new AxeBuilder({ page })
      .setLegacyMode(prefix.startsWith('app:'))
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      result.violations.map((v) => ({ route, id: v.id, targets: v.nodes.map((n) => n.target) })),
    ).toEqual([]);
  }
}
