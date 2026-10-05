import { defineConfig } from '@playwright/test';
import { testEnvironment } from '../tooling/scripts/test-environment.js';

const fixtureRoot = new URL('./tooling/fixtures/', import.meta.url).pathname;

export default defineConfig({
  testDir: './e2e-packaged',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-packaged' }]],
  webServer: {
    command: 'exec bun --no-env-file src/server.ts',
    cwd: fixtureRoot,
    url: 'http://127.0.0.1:45100/products',
    reuseExistingServer: false,
    env: testEnvironment(process.env),
    timeout: 30_000,
  },
});
