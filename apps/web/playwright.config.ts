import { defineConfig, devices } from '@playwright/test';

const apiRoot = new URL('../api/', import.meta.url).pathname;
const fixtureRoot = new URL('../../fixtures/', import.meta.url).pathname;
const webRoot = new URL('./', import.meta.url).pathname;
process.env.PLAYWRIGHT_BROWSERS_PATH ??= new URL(
  '../desktop/resources/playwright/',
  import.meta.url,
).pathname;
const fixturePort = Number(process.env.E2E_FIXTURE_PORT ?? 45100);
const apiPort = Number(process.env.E2E_API_PORT ?? 45300);
const webPort = Number(process.env.E2E_WEB_PORT ?? 45173);
const bootstrapToken =
  process.env.E2E_BOOTSTRAP_TOKEN ?? 'zhiyun-e2e-bootstrap-token-with-at-least-32-bytes';

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'exec bun src/server.ts',
      cwd: fixtureRoot,
      url: `http://127.0.0.1:${fixturePort}/products`,
      env: { ...process.env, FIXTURE_PORT: String(fixturePort) },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'exec bun src/server.ts',
      cwd: apiRoot,
      url: `http://127.0.0.1:${apiPort}/health`,
      env: {
        ...process.env,
        API_PORT: String(apiPort),
        WEB_PORT: String(webPort),
        ZHIYUN_BOOTSTRAP_TOKEN: bootstrapToken,
      },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'exec bun --bun vite --host 0.0.0.0',
      cwd: webRoot,
      url: `http://127.0.0.1:${webPort}`,
      env: {
        ...process.env,
        API_PORT: String(apiPort),
        WEB_PORT: String(webPort),
      },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
