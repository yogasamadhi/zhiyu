#!/usr/bin/env bun

import { existsSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';

const workspaceRoot = import.meta.dir;
const argumentsSet = new Set(process.argv.slice(2));
const desktopFlag = argumentsSet.has('--desktop');
const headlessFlag = argumentsSet.has('--headless');

const options = {
  skipInstall: argumentsSet.has('--skip-install'),
  skipDocker: argumentsSet.has('--skip-docker'),
  stopInfra: argumentsSet.has('--stop-infra'),
  desktop: !headlessFlag,
};

if (argumentsSet.has('--help') || argumentsSet.has('-h')) {
  console.log(`ZhiYun 开发测试环境启动器

用法:
  bun run.ts [选项]                  默认启动桌面应用
  bun run.ts --headless [选项]       启动 Headless/Web 开发环境
  bun run dev -- [选项]

选项:
  --skip-install   不检查 bun.lock 与 node_modules
  --skip-docker    不启动 PostgreSQL 和 Redis（仅 Headless）
  --stop-infra     退出时同时停止 Docker Compose 服务（仅 Headless）
  --desktop        显式启动桌面应用（默认行为，保留兼容）
  --headless       启动 Web、API、PostgreSQL、Redis 和 fixtures
  -h, --help       显示帮助
`);
  process.exit(0);
}

if (desktopFlag && headlessFlag) {
  console.error('--desktop 与 --headless 不能同时使用。');
  process.exit(1);
}

const unknownArguments = [...argumentsSet].filter(
  (argument) =>
    !['--skip-install', '--skip-docker', '--stop-infra', '--desktop', '--headless'].includes(
      argument,
    ),
);

if (unknownArguments.length > 0) {
  console.error(`未知参数: ${unknownArguments.join(', ')}。使用 --help 查看可用选项。`);
  process.exit(1);
}

interface ServiceDefinition {
  name: string;
  command: string[];
  cwd: string;
  healthUrl?: string;
}

interface ManagedService extends ServiceDefinition {
  process: ReturnType<typeof Bun.spawn>;
}

let apiPort = '45300';
let webPort = '45173';
let fixturePort = '45100';
let desktopRendererPort = '45174';
let services: ServiceDefinition[] = [];
let serviceEnvironment = { ...process.env };

const managedServices: ManagedService[] = [];
let shuttingDown = false;
let shutdownPromise: Promise<void> | undefined;

function requireCommand(command: string): void {
  if (!Bun.which(command)) {
    throw new Error(`缺少命令 ${command}，请先安装后重试。`);
  }
}

function requestedPort(name: string, fallback: number): { port: number; explicit: boolean } {
  const configured = process.env[name];
  const port = Number(configured ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} 必须是 1 到 65535 之间的整数。`);
  }
  return { port, explicit: configured !== undefined };
}

function acceptsConnections(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (connected: boolean) => {
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(300, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function isPortAvailable(port: number): Promise<boolean> {
  if ((await acceptsConnections('127.0.0.1', port)) || (await acceptsConnections('::1', port))) {
    return false;
  }
  return new Promise((resolve) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen({ host: '0.0.0.0', port, exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });
}

async function selectPort(
  label: string,
  environmentName: string,
  fallback: number,
  reserved: Set<number>,
): Promise<number> {
  const requested = requestedPort(environmentName, fallback);
  if (!reserved.has(requested.port) && (await isPortAvailable(requested.port))) {
    reserved.add(requested.port);
    return requested.port;
  }
  if (requested.explicit) {
    throw new Error(`${label} 端口 ${requested.port} 已被占用（来自 ${environmentName}）。`);
  }
  for (let candidate = requested.port + 1; candidate <= requested.port + 200; candidate += 1) {
    if (!reserved.has(candidate) && (await isPortAvailable(candidate))) {
      console.warn(`→ ${label} 默认端口 ${requested.port} 已被占用，自动改用 ${candidate}`);
      reserved.add(candidate);
      return candidate;
    }
  }
  throw new Error(`${label} 在 ${requested.port} 后的 200 个端口中都没有找到可用端口。`);
}

async function configureServices(): Promise<void> {
  const reserved = new Set<number>();
  const fixture = await selectPort('Fixtures', 'FIXTURE_PORT', 45100, reserved);
  fixturePort = String(fixture);

  if (options.desktop) {
    desktopRendererPort = String(
      await selectPort('Desktop Renderer', 'DESKTOP_RENDERER_PORT', 45174, reserved),
    );
    services = [
      {
        name: 'Fixtures',
        command: ['bun', '--watch', 'src/server.ts'],
        cwd: join(workspaceRoot, 'fixtures'),
        healthUrl: `http://127.0.0.1:${fixturePort}/products`,
      },
      {
        name: 'Desktop',
        command: ['bun', 'scripts/dev.ts'],
        cwd: join(workspaceRoot, 'apps/desktop'),
        healthUrl: `http://127.0.0.1:${desktopRendererPort}`,
      },
    ];
  } else {
    apiPort = String(await selectPort('API', 'API_PORT', 45300, reserved));
    webPort = String(await selectPort('Web', 'WEB_PORT', 45173, reserved));
    services = [
      {
        name: 'API',
        command: ['bun', '--watch', 'src/server.ts'],
        cwd: join(workspaceRoot, 'apps/api'),
        healthUrl: `http://127.0.0.1:${apiPort}/health`,
      },
      {
        name: 'Web',
        command: ['bun', '--bun', 'vite', '--host', '0.0.0.0'],
        cwd: join(workspaceRoot, 'apps/web'),
        healthUrl: `http://127.0.0.1:${webPort}`,
      },
      {
        name: 'Fixtures',
        command: ['bun', '--watch', 'src/server.ts'],
        cwd: join(workspaceRoot, 'fixtures'),
        healthUrl: `http://127.0.0.1:${fixturePort}/products`,
      },
    ];
  }

  serviceEnvironment = {
    ...process.env,
    API_PORT: apiPort,
    WEB_PORT: webPort,
    FIXTURE_PORT: fixturePort,
    DESKTOP_RENDERER_PORT: desktopRendererPort,
    VITE_FIXTURE_URL: `http://127.0.0.1:${fixturePort}`,
  };
}

async function runStep(label: string, command: string[]): Promise<void> {
  console.log(`\n→ ${label}`);
  const child = Bun.spawn(command, {
    cwd: workspaceRoot,
    env: { ...process.env },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${label}失败，退出码 ${exitCode}。`);
  }
}

async function canReach(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForService(service: ServiceDefinition, timeoutMs = 60_000): Promise<void> {
  if (!service.healthUrl) return;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await canReach(service.healthUrl)) return;
    await Bun.sleep(300);
  }
  throw new Error(`${service.name} 未在 ${timeoutMs / 1000} 秒内就绪：${service.healthUrl}`);
}

async function stopServices(): Promise<void> {
  for (const service of managedServices) {
    if (service.process.exitCode === null) service.process.kill('SIGTERM');
  }

  await Promise.race([
    Promise.allSettled(managedServices.map((service) => service.process.exited)),
    Bun.sleep(5_000),
  ]);

  for (const service of managedServices) {
    if (service.process.exitCode === null) service.process.kill('SIGKILL');
  }
}

async function shutdown(exitCode: number): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    console.log('\n正在停止 ZhiYun 开发服务…');
    await stopServices();
    if (options.stopInfra && !options.skipDocker && !options.desktop) {
      await runStep('停止 PostgreSQL 和 Redis', ['docker', 'compose', 'stop']);
    }
    console.log('开发服务已停止。');
    process.exit(exitCode);
  })();
  return shutdownPromise;
}

process.once('SIGINT', () => void shutdown(0));
process.once('SIGTERM', () => void shutdown(0));

async function main(): Promise<void> {
  requireCommand('bun');
  if (!options.desktop && !options.skipDocker) requireCommand('docker');
  await configureServices();

  if (!options.skipInstall) {
    if (!existsSync(join(workspaceRoot, 'bun.lock'))) {
      throw new Error('缺少 bun.lock，请先执行 bun install。');
    }
    await runStep('检查 Bun 依赖', ['bun', 'install', '--frozen-lockfile']);
  }

  if (!options.desktop && !options.skipDocker) {
    await runStep('启动 PostgreSQL 和 Redis', ['docker', 'compose', 'up', '-d', '--wait']);
  }

  const occupiedServices = (
    await Promise.all(
      services.map(async (service) => ({
        service,
        occupied: service.healthUrl ? await canReach(service.healthUrl) : false,
      })),
    )
  ).filter(({ occupied }) => occupied);

  if (occupiedServices.length > 0) {
    const details = occupiedServices
      .map(({ service }) => `${service.name} (${service.healthUrl})`)
      .join(', ');
    throw new Error(`以下服务已在运行或端口被占用：${details}`);
  }

  console.log('\n→ 启动开发服务');
  for (const service of services) {
    const child = Bun.spawn(service.command, {
      cwd: service.cwd,
      env: serviceEnvironment,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const managedService = { ...service, process: child };
    managedServices.push(managedService);
    void child.exited.then(async (exitCode) => {
      // Ctrl+C 会同时发给当前终端进程组；稍候片刻，让父进程先进入统一关闭流程。
      await Bun.sleep(100);
      if (!shuttingDown) {
        if (exitCode === 130 || exitCode === 143) {
          void shutdown(0);
          return;
        }
        console.error(`\n${service.name} 意外退出，退出码 ${exitCode}。`);
        void shutdown(exitCode || 1);
      }
    });
  }

  await Promise.all(services.map((service) => waitForService(service)));

  const endpoints = options.desktop
    ? `  Desktop Renderer: http://127.0.0.1:${desktopRendererPort}
  Electron Runtime: supervised by Desktop Host
  Static fixture:  http://127.0.0.1:${fixturePort}/products
  Dynamic fixture: http://127.0.0.1:${fixturePort}/dynamic-products`
    : `  Web:             http://127.0.0.1:${webPort}
  API:             http://127.0.0.1:${apiPort}
  Static fixture:  http://127.0.0.1:${fixturePort}/products
  Dynamic fixture: http://127.0.0.1:${fixturePort}/dynamic-products`;

  console.log(`
ZhiYun 开发测试环境已就绪：
${endpoints}

按 Ctrl+C 停止开发服务${options.stopInfra ? '和 Docker 基础设施' : ''}。
`);

  await new Promise<void>(() => undefined);
}

try {
  await main();
} catch (error) {
  console.error(`\n启动失败：${error instanceof Error ? error.message : String(error)}`);
  await shutdown(1);
}
