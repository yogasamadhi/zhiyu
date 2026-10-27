import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const log = await readFile(process.env.DSH_TEST_LOG!, 'utf8');
const url = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)![0];
const browser = await chromium.launch({
  headless: true,
  executablePath: resolve(
    'dsh-plugin/resources/playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ),
});
try {
  const page = await browser.newPage();
  await page.goto(url);
  const rpc = async (method: string, args: unknown = {}) => {
    const endpoint = `zhiyun/${method}`;
    const r = await page.request.post(new URL('/api/' + endpoint, url).href, {
      data: {
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method: endpoint,
        payload: { args },
      },
    });
    return (await r.json()).result;
  };
  const w = await rpc('workspaces');
  console.log(
    await rpc('invoke', {
      input: {
        workspaceId: w.value[0].id,
        operationId: 'getRunDiagnostics',
        path: { runId: process.env.DSH_TEST_RUN },
      },
    }),
  );
} finally {
  await browser.close();
}
