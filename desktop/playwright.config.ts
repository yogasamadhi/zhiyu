import { defineConfig } from '@playwright/test';
import { testEnvironment } from '../tooling/scripts/test-environment.js';

const fixtureRoot = new URL('./tooling/fixtures/', import.meta.url).pathname;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  webServer: {
    command: 'exec bun --no-env-file src/server.ts',
    cwd: fixtureRoot,
    url: 'http://127.0.0.1:45100/products',
    reuseExistingServer: false,
    env: testEnvironment(process.env),
    timeout: 30_000,
  },
});
