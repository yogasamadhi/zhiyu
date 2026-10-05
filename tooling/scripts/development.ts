import { existsSync, readFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

export const workspaceRoot = resolve(import.meta.dir, '../..');

export function readFlags(allowed: string[], help: string): Set<string> {
  const flags = new Set(process.argv.slice(2).filter((argument) => argument !== '--'));
  if (flags.has('--help') || flags.has('-h')) {
    console.log(help);
    process.exit(0);
  }
  const unknown = [...flags].filter((flag) => !allowed.includes(flag));
  if (unknown.length) {
    console.error(`未知参数：${unknown.join(', ')}。使用 --help 查看可用选项。`);
    process.exit(1);
  }
  return flags;
}

export function developmentEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const read = (name: string) => {
    const path = resolve(workspaceRoot, name);
    if (existsSync(path)) Object.assign(environment, parseEnv(readFileSync(path, 'utf8')));
  };
  read('.env');
  const mode = process.env.NODE_ENV ?? environment.NODE_ENV ?? 'development';
  read(`.env.${mode}`);
  if (mode !== 'test') read('.env.local');
  read(`.env.${mode}.local`);
  return { ...environment, NODE_ENV: mode, ...process.env };
}

export function requireCommand(command: string): void {
  if (!Bun.which(command)) throw new Error(`缺少 ${command}，请安装后重试。`);
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

export async function portAvailable(port: number): Promise<boolean> {
  if ((await acceptsConnections('127.0.0.1', port)) || (await acceptsConnections('::1', port)))
    return false;
  return new Promise((resolve) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen({ host: '0.0.0.0', port, exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });
}

export function requestedPort(
  name: string,
  fallback: number,
  environment: NodeJS.ProcessEnv,
): number {
  const port = Number(environment[name] ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error(`${name} 必须是 1 到 65535 之间的整数。`);
  return port;
}

interface PortOwner {
  name: string;
  port: number;
}

async function commandOutput(command: string[]): Promise<{ stdout: string; exitCode: number }> {
  const child = Bun.spawn(command, {
    cwd: workspaceRoot,
    env: process.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, , exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, exitCode };
}

async function listeningProcesses(port: number): Promise<number[]> {
  let result: { stdout: string; exitCode: number };
  if (process.platform === 'win32') {
    const powershell = Bun.which('powershell.exe') ?? Bun.which('pwsh.exe');
    if (!powershell) throw new Error(`端口 ${port} 已占用，但找不到 PowerShell 来定位进程。`);
    result = await commandOutput([
      powershell,
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`,
    ]);
  } else {
    const lsof = Bun.which('lsof');
    if (lsof) {
      result = await commandOutput([lsof, '-nP', '-t', '-a', `-iTCP:${port}`, '-sTCP:LISTEN']);
    } else {
      const fuser = Bun.which('fuser');
      if (!fuser) throw new Error(`端口 ${port} 已占用，但找不到 lsof 或 fuser 来定位进程。`);
      result = await commandOutput([fuser, '-n', 'tcp', String(port)]);
    }
  }
  if (result.exitCode !== 0 && result.exitCode !== 1)
    throw new Error(`查询端口 ${port} 的占用进程失败，退出码 ${result.exitCode}。`);
  return [
    ...new Set(
      result.stdout
        .split(/\s+/u)
        .map(Number)
        .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid),
    ),
  ];
}

async function processTree(roots: number[]): Promise<number[]> {
  if (process.platform === 'win32' || roots.length === 0) return roots;
  const result = await commandOutput(['ps', '-axo', 'pid=,ppid=']);
  if (result.exitCode !== 0) return roots;
  const relationships = result.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/u).map(Number))
    .filter((pair): pair is [number, number] => pair.length === 2 && pair.every(Number.isInteger));
  const tree = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of relationships) {
      if (!tree.has(parent) || tree.has(pid) || pid === process.pid) continue;
      tree.add(pid);
      changed = true;
    }
  }
  return [...tree].reverse();
}

async function terminateProcesses(pids: number[], force: boolean): Promise<void> {
  if (pids.length === 0) return;
  if (process.platform === 'win32') {
    for (const pid of pids) {
      await commandOutput(['taskkill', '/PID', String(pid), '/T', ...(force ? ['/F'] : [])]);
    }
    return;
  }
  for (const pid of await processTree(pids)) {
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}

async function waitForFreePort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let freeSince: number | undefined;
  while (Date.now() < deadline) {
    if (await portAvailable(port)) {
      freeSince ??= Date.now();
      // Watchers can restart a listener shortly after its child receives SIGTERM.
      // Require a quiet period before handing the same port to the new application.
      if (Date.now() - freeSince >= 1_200) return true;
    } else {
      freeSince = undefined;
    }
    await Bun.sleep(100);
  }
  return false;
}

export async function releaseOccupiedPorts(ports: PortOwner[]): Promise<void> {
  for (const { name, port } of ports) {
    if (await portAvailable(port)) continue;
    const owners = await listeningProcesses(port);
    if (owners.length === 0) throw new Error(`${name} 端口 ${port} 已占用，但无法确定监听进程。`);
    console.warn(`→ ${name} 端口 ${port} 已占用，停止进程 ${owners.join(', ')}`);
    await terminateProcesses(owners, false);
    if (await waitForFreePort(port, 3_000)) continue;
    const remaining = await listeningProcesses(port);
    if (remaining.length > 0) {
      console.warn(`→ ${name} 端口 ${port} 仍被占用，强制停止进程 ${remaining.join(', ')}`);
      await terminateProcesses(remaining, true);
    }
    if (!(await waitForFreePort(port, 2_000)))
      throw new Error(`${name} 端口 ${port} 无法释放，请检查进程权限或进程管理器。`);
  }
}

export async function assertPortsAvailable(ports: PortOwner[]): Promise<void> {
  for (const { name, port } of ports) {
    if (!(await portAvailable(port)))
      throw new Error(`${name} 端口 ${port} 已占用；隔离测试不会终止现有进程。`);
  }
}

export async function selectPort(
  name: string,
  fallback: number,
  environment: NodeJS.ProcessEnv,
  reserved: Set<number>,
): Promise<number> {
  const configured = environment[name];
  const requested = requestedPort(name, fallback, environment);
  const last = configured === undefined ? Math.min(requested + 200, 65_535) : requested;
  for (let port = requested; port <= last; port += 1) {
    if (reserved.has(port) || !(await portAvailable(port))) continue;
    reserved.add(port);
    if (port !== requested) console.warn(`→ ${name} 默认端口 ${requested} 已占用，改用 ${port}`);
    return port;
  }
  throw new Error(`${name} 端口 ${requested} 已占用或没有可用端口，请修改该环境变量。`);
}

interface Service {
  name: string;
  command: string[];
  cwd?: string;
  allowCleanExit?: boolean;
}

export class DevelopmentProcesses {
  private children = new Set<ReturnType<typeof Bun.spawn>>();
  private shutdownPromise: Promise<never> | undefined;

  constructor(private readonly environment: NodeJS.ProcessEnv) {
    // Keep the listeners installed while cleanup is running, so repeated Ctrl+C
    // cannot bypass the final process-tree kill.
    process.on('SIGINT', () => void this.shutdown(0));
    process.on('SIGTERM', () => void this.shutdown(0));
  }

  private spawn(service: Service) {
    if (this.shutdownPromise) throw new Error('启动器正在停止。');
    console.log(`→ ${service.name}`);
    const command =
      this.environment.NODE_ENV === 'test' && service.command[0] === 'bun'
        ? ['bun', '--no-env-file', ...service.command.slice(1)]
        : service.command;
    const child = Bun.spawn(command, {
      cwd: service.cwd ?? workspaceRoot,
      env: { ...this.environment, BUN_FEATURE_FLAG_NO_ORPHANS: '1' },
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      // Own process groups include watch/build grandchildren, never unrelated services.
      detached: true,
      windowsHide: true,
    });
    this.children.add(child);
    return child;
  }

  async step(name: string, command: string[], cwd = workspaceRoot): Promise<void> {
    const child = this.spawn({ name, command, cwd });
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`${name}失败，退出码 ${exitCode}。`);
    this.children.delete(child);
  }

  start(service: Service): void {
    const child = this.spawn(service);
    void child.exited.then((exitCode) => {
      if (this.shutdownPromise) return;
      const expected = service.allowCleanExit && exitCode === 0;
      if (!expected) console.error(`${service.name} 意外退出，退出码 ${exitCode}。`);
      void this.shutdown(expected ? 0 : exitCode || 1);
    });
  }

  async ready(name: string, url: string, timeoutMs = 90_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.shutdownPromise) await this.shutdownPromise;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        const ok = response.ok;
        await response.body?.cancel();
        if (ok) return;
      } catch {
        // A listening socket does not imply that the application has finished starting.
      }
      await Bun.sleep(300);
    }
    if (this.shutdownPromise) await this.shutdownPromise;
    throw new Error(`${name} 未在 ${timeoutMs / 1000} 秒内就绪：${url}`);
  }

  private async signal(child: ReturnType<typeof Bun.spawn>, signal: NodeJS.Signals) {
    try {
      if (process.platform === 'win32') {
        if (child.exitCode === null)
          await Bun.spawn(
            ['taskkill', '/PID', String(child.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])],
            {
              stdout: 'ignore',
              stderr: 'ignore',
            },
          ).exited;
      } else {
        process.kill(-child.pid, signal);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
        console.error(`无法停止子进程 ${child.pid}：${String(error)}`);
    }
  }

  private processTreeAlive(child: ReturnType<typeof Bun.spawn>): boolean {
    if (process.platform === 'win32') return child.exitCode === null;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      return true;
    }
  }

  private async waitForProcessTrees(
    children: Array<ReturnType<typeof Bun.spawn>>,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (children.every((child) => !this.processTreeAlive(child))) return true;
      await Bun.sleep(100);
    }
    return children.every((child) => !this.processTreeAlive(child));
  }

  shutdown(exitCode: number): Promise<never> {
    this.shutdownPromise ??= (async () => {
      console.log('\n正在停止开发进程…');
      const children = [...this.children];
      await Promise.all(children.map((child) => this.signal(child, 'SIGTERM')));
      await this.waitForProcessTrees(children, 5_000);
      // A watcher may exit before its grandchildren, so also clean groups whose leader exited.
      const remaining = children.filter((child) => this.processTreeAlive(child));
      await Promise.all(remaining.map((child) => this.signal(child, 'SIGKILL')));
      const cleaned = await this.waitForProcessTrees(remaining, 2_000);
      if (!cleaned) console.error('部分开发子进程未能确认退出。');
      process.exit(!cleaned && exitCode === 0 ? 1 : exitCode);
    })();
    return this.shutdownPromise;
  }
}
