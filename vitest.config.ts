import { defineConfig } from 'vitest/config';

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
