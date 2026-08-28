import { defineConfig } from '@playwright/test';

const fixtureRoot = new URL('../../fixtures/', import.meta.url).pathname;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  webServer: {
    command: 'exec bun src/server.ts',
    cwd: fixtureRoot,
    url: 'http://127.0.0.1:45100/products',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
