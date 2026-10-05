import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo } from '@playwright/test';

export async function exerciseAssistant(page: Page, base: string, info: TestInfo) {
  const errors: string[] = [];
  const onError = (error: Error) => errors.push(error.message);
  page.on('pageerror', onError);
  try {
    await page.goto(`${base}/`);
    await page.getByRole('button', { name: '用样例带我体验', exact: true }).click();
    await expect(page.getByRole('heading', { name: '织云助手', exact: true })).toBeVisible();
    await expect(page.getByText('固定引导与离线练习可用', { exact: true })).toBeVisible();
    const card = page
      .locator('.assistant-action-card')
      .filter({ hasText: '创建离线商品样例' })
      .last();
    await card.getByRole('button', { name: '执行此操作', exact: true }).click();
    await expect(card.getByText('操作已完成', { exact: true })).toBeVisible();
    let lesson = page.locator('.assistant-lesson').last();
    await lesson.getByRole('button', { name: '检查这一步', exact: true }).click();
    await expect(lesson.getByRole('heading', { name: '检查真实提取结果' })).toBeVisible();
    await lesson.getByRole('button', { name: '检查这一步', exact: true }).click();
    await expect(page.locator('.assistant-sample-table tbody tr')).toHaveCount(6);
    const conversationUrl = page.url();
    await page.reload();
    await expect(page.locator('.assistant-sample-table tbody tr')).toHaveCount(6);
    await page.getByLabel('助手帮助方式').selectOption('do');
    await expect(page.getByLabel('助手帮助方式')).toHaveValue('do');
    await page.locator('.assistant-course-list summary').click();
    await page.getByRole('button', { name: '分页与加载更多', exact: true }).click();
    lesson = page.locator('.assistant-lesson').last();
    await lesson.getByRole('button', { name: '检查这一步', exact: true }).click();
    await expect(
      page.getByText('当前只查看了第一批，请加载第二批。', { exact: true }),
    ).toBeVisible();
    await lesson.getByRole('button', { name: '加载更多', exact: true }).click();
    await expect(lesson.getByRole('button', { name: '已显示全部 6 条' })).toBeDisabled();
    await lesson.getByRole('button', { name: '检查这一步', exact: true }).click();
    await expect(lesson.getByRole('button', { name: '重新练习', exact: true })).toBeVisible();
    for (const width of [360, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByLabel('发送给织云助手')).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      ).toBe(true);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: info.outputPath(`assistant-${width}.png`), fullPage: true });
    }
    await page.locator('.language-button').click();
    await expect(
      page.getByRole('heading', { name: 'ZhiYun assistant', exact: true }),
    ).toBeVisible();
    for (const width of [360, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByLabel('Message ZhiYun assistant')).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: info.outputPath(`assistant-en-${width}.png`), fullPage: true });
    }
    await page.locator('.language-button').click();
    const accessibility = await new AxeBuilder({ page })
      .setLegacyMode(base.startsWith('app:'))
      .include('.zhiyun-assistant')
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(
      accessibility.violations.map((violation) => `${violation.id}: ${violation.description}`),
    ).toEqual([]);
    await page.goto(`${base}/tasks`);
    const launcher = page.getByRole('button', { name: '打开织云助手', exact: true });
    await launcher.click();
    await expect(page.getByRole('complementary', { name: '织云助手侧栏' })).toBeVisible();
    await expect(page.getByLabel('发送给织云助手')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('complementary', { name: '织云助手侧栏' })).toHaveCount(0);
    await expect(launcher).toBeFocused();
    await page.goto(conversationUrl);
    await page.getByLabel('发送给织云助手').fill('价格字段是什么意思？');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByText('固定引导 · 尚未连接 AI 模型', { exact: false })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    page.off('pageerror', onError);
  }
}
