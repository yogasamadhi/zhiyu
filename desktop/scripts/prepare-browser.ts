import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const desktopRoot = resolve(import.meta.dirname, '..');
const browserDirectory = resolve(desktopRoot, 'resources/playwright');
await rm(browserDirectory, { recursive: true, force: true });
const child = spawnSync('pnpm', ['exec', 'playwright', 'install', 'chromium'], {
  cwd: desktopRoot,
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserDirectory },
  stdio: 'inherit',
});
process.exit(child.status ?? 1);
