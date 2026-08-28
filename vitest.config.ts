import { defineConfig } from 'vitest/config';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= new URL(
  './apps/desktop/resources/playwright/',
  import.meta.url,
).pathname;

export default defineConfig({
  test: {
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
