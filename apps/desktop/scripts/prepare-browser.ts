import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const desktopRoot = resolve(import.meta.dir, '..');
const browserDirectory = resolve(desktopRoot, 'resources/playwright');
await rm(browserDirectory, { recursive: true, force: true });
const child = Bun.spawn(['bunx', 'playwright', 'install', 'chromium'], {
  cwd: desktopRoot,
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserDirectory },
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(await child.exited);
