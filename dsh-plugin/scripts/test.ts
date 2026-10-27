import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const child = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.dsh.config.ts'], {
  cwd: resolve(root, '..'),
  stdio: 'inherit',
  env: { PATH: process.env.PATH!, HOME: process.env.HOME!, NODE_ENV: 'test' },
});
process.exitCode = child.status ?? 1;
