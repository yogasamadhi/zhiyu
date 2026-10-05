import { defineConfig } from 'vitest/config';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= new URL(
  './desktop/resources/playwright/',
  import.meta.url,
).pathname;

process.env.CRAWLEE_STORAGE_DIR ??= new URL('./.data/crawlee-tests/', import.meta.url).pathname;

export default defineConfig({
  test: {
    // Crawlee, native SQLite modules and isolated runtime fixtures own process/global
    // resources; serial files make the all-in-one PR gate deterministic across CI runners.
    fileParallelism: false,
    include: ['desktop/**/test/**/*.test.ts'],
    coverage: { reporter: ['text', 'html'] },
  },
});
