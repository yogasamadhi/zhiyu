import { _electron as electron } from 'playwright';
import { resolve } from 'node:path';
import { mkdir, access } from 'node:fs/promises';
const root = resolve('.artifacts/dsh-plugin');
const home = resolve(root, 'desktop-home');
await mkdir(home, { recursive: true });
const app = await electron.launch({
  executablePath: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
  args: [`--user-data-dir=${resolve(root, 'desktop-user-data')}`],
  env: { PATH: process.env.PATH!, HOME: home, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
  timeout: 120000,
});
try {
  for (let i = 0; i < 120; i++) {
    if (
      await access(resolve(home, 'profiles/desktop/package.json')).then(
        () => true,
        () => false,
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log('PROFILE_INITIALIZED');
  for (const page of app.windows()) {
    await page.waitForTimeout(1500);
    console.log(
      'WINDOW',
      page.url(),
      await page
        .locator('body')
        .innerText()
        .catch(() => ''),
    );
  }
} finally {
  await app.close();
}
