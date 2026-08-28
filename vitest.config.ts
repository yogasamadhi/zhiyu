import { defineConfig } from 'vitest/config';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= new URL(
  './apps/desktop/resources/playwright/',
  import.meta.url,
).pathname;

export default defineConfig({
  test: {
    // Crawlee, native SQLite modules and PostgreSQL conformance fixtures own process/global
    // resources; serial files make the all-in-one PR gate deterministic across CI runners.
    fileParallelism: false,
    include: [
      'packages/**/test/**/*.test.ts',
      'plugins/**/test/**/*.test.ts',
      'capabilities/**/test/**/*.test.ts',
      'services/**/test/**/*.test.ts',
      'profiles/**/test/**/*.test.ts',
      'apps/**/test/**/*.test.ts',
    ],
    coverage: { reporter: ['text', 'html'] },
  },
});
