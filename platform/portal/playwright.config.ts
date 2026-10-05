import { defineConfig } from '@playwright/test';
const portalPort = process.env.CLOUD_PORTAL_PORT ?? '3130';
const adminPort = process.env.CLOUD_ADMIN_PORT ?? '3131';
const apiPort = process.env.CLOUD_PORT ?? '3230';
const portalOrigin = `http://localhost:${portalPort}`;
const adminOrigin = `http://localhost:${adminPort}`;
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 60000,
  workers: 1,
  fullyParallel: false,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: '../../.artifacts/playwright/cloud' }],
  ],
  use: {
    baseURL: portalOrigin,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command:
      'bun --no-env-file platform/tooling/scripts/seed-e2e.ts && bun --no-env-file run-platform.ts --isolated-test --skip-install --skip-migrate',
    cwd: '../..',
    url: portalOrigin,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    timeout: 120000,
    env: {
      CLOUD_PORTAL_PORT: portalPort,
      CLOUD_ADMIN_PORT: adminPort,
      CLOUD_PORT: apiPort,
      CLOUD_SERVER_URL: `http://127.0.0.1:${apiPort}`,
      CLOUD_DATABASE_URL:
        process.env.CLOUD_E2E_DATABASE_URL ??
        'postgres://zhiyun:zhiyun-local@127.0.0.1:55432/zhiyun_cloud_e2e_test',
      CLOUD_MOCK_PAYMENTS: 'true',
      CLOUD_REAL_MESSAGES: 'false',
      CLOUD_PORTAL_ORIGIN: portalOrigin,
      CLOUD_ADMIN_ORIGIN: adminOrigin,
    },
  },
});
