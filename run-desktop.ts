#!/usr/bin/env bun

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DevelopmentProcesses,
  developmentEnvironment,
  readFlags,
  requireCommand,
  selectPort,
  workspaceRoot,
} from './tooling/scripts/development.js';

const flags = readFlags(
  ['--skip-install', '--desktop'],
  `织云桌面开发启动器

用法：bun run-desktop.ts [--skip-install]
      bun run desktop:dev

默认检查 Bun 依赖、同步 Python 环境、构建并启动 Electron、Renderer 和本地测试站点。
  --skip-install  使用现有 node_modules 和 Python 虚拟环境
  -h, --help      显示帮助

端口可通过 DESKTOP_RENDERER_PORT、FIXTURE_PORT 配置。
首次开发请先执行 bun run desktop:browser 安装本地 Chromium。
`,
);
const environment = developmentEnvironment();
const processes = new DevelopmentProcesses(environment);

try {
  requireCommand('bun');
  requireCommand('node');
  const reserved = new Set<number>();
  const fixturePort = await selectPort('FIXTURE_PORT', 45100, environment, reserved);
  const rendererPort = await selectPort('DESKTOP_RENDERER_PORT', 45174, environment, reserved);
  const fixtureUrl = `http://127.0.0.1:${fixturePort}`;
  const rendererUrl = `http://127.0.0.1:${rendererPort}`;
  Object.assign(environment, {
    FIXTURE_PORT: String(fixturePort),
    DESKTOP_RENDERER_PORT: String(rendererPort),
    VITE_FIXTURE_URL: fixtureUrl,
    ZHIYUN_DESKTOP_DEV_URL: rendererUrl,
  });

  if (!flags.has('--skip-install')) {
    requireCommand('uv');
    await processes.step('检查 Bun 依赖', ['bun', 'install', '--frozen-lockfile']);
    await processes.step(
      '同步 Python Worker',
      ['uv', 'sync', '--frozen'],
      resolve(workspaceRoot, 'desktop/analytics-worker'),
    );
  }
  const python = resolve(
    workspaceRoot,
    'desktop/analytics-worker/.venv',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  if (!existsSync(python)) throw new Error('Python 环境缺失，请先执行 bun run worker:sync。');

  const desktopRoot = resolve(workspaceRoot, 'desktop');
  await processes.step('构建桌面应用', ['bun', 'scripts/build.ts'], desktopRoot);
  processes.start({
    name: 'Fixtures',
    command: ['bun', '--watch', 'src/server.ts'],
    cwd: resolve(workspaceRoot, 'desktop/tooling/fixtures'),
  });
  processes.start({
    name: 'Desktop Renderer',
    command: ['bun', '--bun', 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1'],
    cwd: desktopRoot,
  });
  await Promise.all([
    processes.ready('Fixtures', `${fixtureUrl}/products`),
    processes.ready('Desktop Renderer', rendererUrl),
  ]);
  processes.start({
    name: 'Electron',
    command: ['node', 'node_modules/electron/cli.js', '.'],
    cwd: desktopRoot,
    allowCleanExit: true,
  });
  console.log(`\n桌面开发服务已启动：
  Renderer: ${rendererUrl}
  本地测试站点: ${fixtureUrl}/products
  Python Worker 与本地运行时由 Electron 管理。

按 Ctrl+C 停止桌面开发进程。`);
} catch (error) {
  console.error(`启动失败：${error instanceof Error ? error.message : String(error)}`);
  await processes.shutdown(1);
}
