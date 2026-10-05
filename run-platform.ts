#!/usr/bin/env bun

import { resolve } from 'node:path';
import {
  DevelopmentProcesses,
  assertPortsAvailable,
  developmentEnvironment,
  readFlags,
  releaseOccupiedPorts,
  requestedPort,
  requireCommand,
  workspaceRoot,
} from './tooling/scripts/development.js';
import { assertTestDatabase, testEnvironment } from './tooling/scripts/test-environment.js';

const flags = readFlags(
  ['--skip-install', '--skip-migrate', '--infra', '--isolated-test'],
  `织云商业平台开发启动器

用法：bun run-platform.ts [选项]
      bun run platform:dev

启动 Server API、云端后台任务、Admin 和 Portal。
默认检查 Bun 依赖并应用数据库迁移，需要已有 PostgreSQL 和 Redis。
  --infra         先用 Docker Compose 启动本地 PostgreSQL 和 Redis
  --skip-install  使用现有 node_modules
  --skip-migrate  跳过数据库迁移（数据库必须已经初始化）
  --isolated-test 不读取项目环境文件，使用 Mock，并拒绝终止占用端口的进程
  -h, --help      显示帮助

默认端口：Server 3200、Portal 3100、Admin 3101。
启动前会停止任何占用目标 TCP 监听端口的进程，请确认端口配置无误。
支持 CLOUD_PORT、CLOUD_PORTAL_PORT、CLOUD_ADMIN_PORT 及 CLOUD_* 环境配置。
Ctrl+C 停止本次启动的 Server、Worker、Portal、Admin 及其子进程；Docker 数据库保持运行。
`,
);
const environment = flags.has('--isolated-test')
  ? {
      ...testEnvironment(process.env),
      ...Object.fromEntries(
        [
          'CLOUD_DATABASE_URL',
          'CLOUD_REDIS_URL',
          'CLOUD_PORT',
          'CLOUD_PORTAL_PORT',
          'CLOUD_ADMIN_PORT',
          'CLOUD_SERVER_URL',
          'CLOUD_PORTAL_ORIGIN',
          'CLOUD_ADMIN_ORIGIN',
        ].flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
      ),
    }
  : developmentEnvironment();
const preparePorts = flags.has('--isolated-test') ? assertPortsAvailable : releaseOccupiedPorts;
const processes = new DevelopmentProcesses(environment);

try {
  requireCommand('bun');
  if (environment.NODE_ENV === 'production')
    throw new Error('此脚本用于开发；生产环境请使用 platform/deploy 的构建和部署流程。');
  if (flags.has('--isolated-test')) {
    assertTestDatabase(environment.CLOUD_DATABASE_URL ?? '', 'e2e');
    if (flags.has('--infra')) throw new Error('隔离测试必须使用本轮专属基础设施。');
  }
  const apiPort = requestedPort('CLOUD_PORT', 3200, environment);
  const portalPort = requestedPort('CLOUD_PORTAL_PORT', 3100, environment);
  const adminPort = requestedPort('CLOUD_ADMIN_PORT', 3101, environment);
  if (new Set([apiPort, portalPort, adminPort]).size !== 3)
    throw new Error('CLOUD_PORT、CLOUD_PORTAL_PORT、CLOUD_ADMIN_PORT 必须使用不同端口。');
  await preparePorts([
    { name: 'Server API', port: apiPort },
    { name: 'Portal', port: portalPort },
    { name: 'Admin', port: adminPort },
  ]);
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const portalUrl = `http://localhost:${portalPort}`;
  const adminUrl = `http://localhost:${adminPort}`;
  Object.assign(environment, {
    CLOUD_PORT: String(apiPort),
    CLOUD_PORTAL_PORT: String(portalPort),
    CLOUD_ADMIN_PORT: String(adminPort),
    CLOUD_SERVER_URL: environment.CLOUD_SERVER_URL ?? apiUrl,
    CLOUD_PORTAL_ORIGIN: environment.CLOUD_PORTAL_ORIGIN ?? portalUrl,
    CLOUD_ADMIN_ORIGIN: environment.CLOUD_ADMIN_ORIGIN ?? adminUrl,
  });
  if (!flags.has('--skip-install'))
    await processes.step('检查 Bun 依赖', ['bun', 'install', '--frozen-lockfile']);
  if (flags.has('--infra')) {
    requireCommand('docker');
    await processes.step('启动本地 PostgreSQL / Redis', [
      'docker',
      'compose',
      '-f',
      'platform/deploy/compose.yml',
      'up',
      '-d',
      '--wait',
      'postgres',
      'redis',
    ]);
  }
  if (!flags.has('--skip-migrate'))
    await processes.step('应用云端数据库迁移', ['bun', 'platform/server/src/migrate.ts']);

  await preparePorts([{ name: 'Server API', port: apiPort }]);
  processes.start({
    name: 'Server API',
    command: ['bun', '--watch', 'platform/server/src/start.ts'],
  });
  await processes.ready('Server API（PostgreSQL 需可用）', `${apiUrl}/api/cloud/v1/health`);
  processes.start({
    name: 'Server Worker',
    command: ['bun', '--watch', 'platform/server/src/worker.ts'],
  });
  await preparePorts([
    { name: 'Portal', port: portalPort },
    { name: 'Admin', port: adminPort },
  ]);
  processes.start({
    name: 'Portal',
    cwd: resolve(workspaceRoot, 'platform/portal'),
    command: ['bun', '--bun', 'node_modules/next/dist/bin/next', 'dev', '-p', String(portalPort)],
  });
  processes.start({
    name: 'Admin',
    cwd: resolve(workspaceRoot, 'platform/admin'),
    command: [
      'bun',
      '--bun',
      'node_modules/vite/bin/vite.js',
      '--host',
      '127.0.0.1',
      '--port',
      String(adminPort),
      '--strictPort',
    ],
  });
  await Promise.all([processes.ready('Portal', portalUrl), processes.ready('Admin', adminUrl)]);
  console.log(`\n商业平台已就绪：
  Server: ${apiUrl}/api/cloud/v1
  Portal: ${portalUrl}
  Admin:  ${adminUrl}
  云端后台任务已启动。

按 Ctrl+C 停止商业平台应用。`);
} catch (error) {
  console.error(`启动失败：${error instanceof Error ? error.message : String(error)}`);
  await processes.shutdown(1);
}
