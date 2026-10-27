import { configDefaults, defineConfig } from 'vitest/config';

// Platform tests run outside the desktop Vitest project. They own database and
// Redis fixtures, so files stay serial and the suite runs against the isolated
// Compose environment.
export default defineConfig({
  test: {
    fileParallelism: false,
    include: ['platform/**/tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'vendor/**'],
  },
});
