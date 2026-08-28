import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const desktopRoot = resolve(import.meta.dir, '..');
const stagingRoot = resolve(desktopRoot, '.forge-app');
await rm(stagingRoot, { recursive: true, force: true });
await mkdir(stagingRoot, { recursive: true });
await cp(resolve(desktopRoot, 'dist'), resolve(stagingRoot, 'dist'), { recursive: true });
await writeFile(
  resolve(stagingRoot, 'package.json'),
  JSON.stringify(
    {
      name: 'zhiyun-desktop-runtime',
      productName: 'ZhiYun',
      version: '0.2.0',
      private: true,
      type: 'module',
      main: 'dist/main.js',
      dependencies: {
        'better-sqlite3': '13.0.3',
        'node-addon-api': '^8.0.0',
        playwright: '1.62.1',
        'playwright-core': '1.62.1',
      },
      devDependencies: { electron: '44.0.0' },
      config: { forge: '../forge.config.ts' },
    },
    null,
    2,
  ),
);
const install = Bun.spawn(['bun', 'install', '--ignore-scripts', '--linker=hoisted'], {
  cwd: stagingRoot,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
const exitCode = await install.exited;
if (exitCode !== 0) throw new Error(`Forge staging dependency install exited with ${exitCode}`);
