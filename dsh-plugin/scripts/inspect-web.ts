import { readFile } from 'node:fs/promises';
import { chromium } from '../resources/runtime/node_modules/playwright/index.mjs';
const log = await readFile(
  process.env.DSH_TEST_LOG ?? '.artifacts/dsh-plugin/web-host.log',
  'utf8',
);
const url = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0];
if (!url) throw new Error('No test host URL');
const browser = await chromium.launch({
  headless: true,
  executablePath: (await import('node:path')).resolve(
    'dsh-plugin/resources/playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ),
});
const page = await browser.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  errors.push(m.type() + ': ' + m.text());
});
await page.goto(url);
await page.waitForTimeout(3000);
console.log('Boot:', await page.locator('body').innerText());
if (await page.getByText('继续', { exact: true }).count())
  await page.getByText('继续', { exact: true }).click();
console.log('Before panel:', await page.locator('body').innerText());
await page.screenshot({ path: '.artifacts/dsh-plugin/web-before-panel.png' });
await page.getByText('织云', { exact: true }).click();
await page.waitForTimeout(10000);
console.log('Panel initial:', await page.locator('body').innerText(), errors);
await page.screenshot({ path: '.artifacts/dsh-plugin/web-panel.png' });
await browser.close();
