import { configDefaults, defineConfig } from 'vitest/config';

// The DSH plugin ships as a separate package with its own runtime contract
// tests. They run against the packaged plugin sources.
export default defineConfig({
  test: {
    fileParallelism: false,
    include: ['dsh-plugin/test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'vendor/**'],
  },
});
