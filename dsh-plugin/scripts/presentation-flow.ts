import type { Page } from 'playwright';
import { strict as assert } from 'node:assert';
export async function presentationFlow(
  page: Page,
  rpc: (method: string, args?: Record<string, unknown>) => Promise<unknown>,
  workspaceId: string,
) {
  const address = page.url();
  await rpc('settings/update', { ns: 'ui-theme', patch: { preference: 'dark' } });
  await page.waitForFunction(
    () => document.querySelector('.zhiyun-workbench')?.getAttribute('data-theme') === 'dark',
  );
  const dark = await page
    .locator('.zhiyun-workbench')
    .evaluate((element) => getComputedStyle(element).getPropertyValue('--bg'));
  await rpc('settings/update', { ns: 'ui-theme', patch: { preference: 'light' } });
  await page.waitForFunction(
    () => document.querySelector('.zhiyun-workbench')?.getAttribute('data-theme') === 'light',
  );
  const light = await page
    .locator('.zhiyun-workbench')
    .evaluate((element) => getComputedStyle(element).getPropertyValue('--bg'));
  assert.notEqual(dark, light);
  await rpc('settings/update', { ns: 'locale', patch: { preference: 'en' } });
  await page.getByRole('link', { name: 'Collection', exact: true }).waitFor();
  await rpc('settings/update', { ns: 'locale', patch: { preference: 'zh' } });
  await page.getByRole('link', { name: '采集任务', exact: true }).waitFor();
  const before = (await rpc('status', { workspaceId })) as { generation: number };
  await page.getByText('插件', { exact: true }).first().click();
  await page.waitForFunction(() => !document.querySelector('.zhiyun-workbench'));
  await page.getByText('织云', { exact: true }).click();
  await page.getByRole('link', { name: '采集任务', exact: true }).waitFor();
  const after = (await rpc('status', { workspaceId })) as { generation: number };
  assert.equal(after.generation, before.generation);
  assert.equal(page.url(), address);
  console.log('THEME_LANGUAGE_PANEL_LIFETIME_PASSED');
}
