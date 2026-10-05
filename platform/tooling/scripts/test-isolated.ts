import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertTestDatabase,
  availableTestPort,
  testEnvironment,
} from '../../../tooling/scripts/test-environment.js';
import { portAvailable } from '../../../tooling/scripts/development.js';

const mode = process.argv[2];
if (!['unit', 'e2e', 'all'].includes(mode ?? '') || process.argv.length !== 3)
  throw new Error(
    'Usage: bun --no-env-file platform/tooling/scripts/test-isolated.ts unit|e2e|all',
  );

const root = resolve(import.meta.dir, '../../..');
const identifier = crypto.randomUUID().replaceAll('-', '');
const project = `zhiyun-test-${identifier}`;
const temporary = await mkdtemp(join(tmpdir(), 'zhiyun-cloud-test-'));
const environment = testEnvironment(process.env);
const children = new Set<ReturnType<typeof Bun.spawn>>();
let interrupted = false;
let cleaning = false;
let composeStarted = false;
let exitCode = 1;
const applicationPorts: number[] = [];

async function signal(child: ReturnType<typeof Bun.spawn>, force = false): Promise<void> {
  try {
    if (process.platform === 'win32') {
      if (child.exitCode === null)
        await Bun.spawn(['taskkill', '/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])], {
          env: environment,
          stdout: 'ignore',
          stderr: 'ignore',
        }).exited;
    } else process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function alive(child: ReturnType<typeof Bun.spawn>): boolean {
  if (process.platform === 'win32') return child.exitCode === null;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function stop(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (!alive(child)) return;
  await signal(child);
  const deadline = Date.now() + 10_000;
  while (alive(child) && Date.now() < deadline) await Bun.sleep(100);
  if (alive(child)) await signal(child, true);
  await child.exited;
}

const interrupt = () => {
  if (cleaning) return;
  interrupted = true;
  for (const child of children) void signal(child).catch(() => undefined);
};
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);

async function forward(stream: ReadableStream<Uint8Array>, destination: NodeJS.WriteStream) {
  for await (const chunk of stream) destination.write(chunk);
  return '';
}

async function run(command: string[], capture = false, cleanup = false): Promise<string> {
  if (interrupted && !cleanup) throw new Error('Isolated tests interrupted');
  const child = Bun.spawn(command, {
    cwd: root,
    env: environment,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
    windowsHide: true,
  });
  children.add(child);
  try {
    const [output, , code] = await Promise.all([
      capture ? new Response(child.stdout).text() : forward(child.stdout, process.stdout),
      forward(child.stderr, process.stderr),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${command[0]} ${command[1]} exited with code ${code}`);
    return output.trim();
  } finally {
    await stop(child);
    children.delete(child);
  }
}

const emptyEnvironmentFile = join(temporary, 'empty.env');
const compose = [
  'docker',
  'compose',
  '--project-name',
  project,
  '--env-file',
  emptyEnvironmentFile,
  '-f',
  join(root, 'platform/deploy/compose.test.yml'),
];

async function publishedPort(service: string, port: number): Promise<number> {
  const binding = await run([...compose, 'port', service, String(port)], true);
  const match = /^127\.0\.0\.1:(\d+)$/.exec(binding);
  if (!match) throw new Error(`Unexpected local test port binding for ${service}`);
  return Number(match[1]);
}

try {
  await writeFile(emptyEnvironmentFile, '');
  await run(['docker', 'info', '--format', '{{.ServerVersion}}'], true);
  composeStarted = true;
  await run([...compose, 'up', '-d', '--wait', '--wait-timeout', '90']);
  const postgresPort = await publishedPort('postgres', 5432);
  const redisPort = await publishedPort('redis', 6379);
  const database = `postgres://zhiyun_test:local-test-only@127.0.0.1:${postgresPort}/zhiyun_${identifier}`;
  const unitDatabase = `${database}_test`;
  const e2eDatabase = `${database}_e2e_test`;
  assertTestDatabase(unitDatabase);
  assertTestDatabase(e2eDatabase, 'e2e');
  Object.assign(environment, {
    CLOUD_TEST_DATABASE_URL: unitDatabase,
    CLOUD_E2E_DATABASE_URL: e2eDatabase,
    CLOUD_REDIS_URL: `redis://127.0.0.1:${redisPort}`,
    ZHIYUN_DATA_DIR: join(temporary, 'desktop-data'),
    CRAWLEE_STORAGE_DIR: join(temporary, 'crawlee'),
  });
  console.log(`Isolated test run ${identifier}; owned Compose project ${project}`);
  if (mode === 'unit' || mode === 'all') {
    await run(['bun', '--no-env-file', 'test', 'platform/tooling/tests']);
    await run(['bun', '--no-env-file', 'test', 'platform/server/tests']);
  }
  if (mode === 'e2e' || mode === 'all') {
    const ports = new Set<number>();
    while (ports.size < 3) ports.add(await availableTestPort());
    const [api, portal, admin] = [...ports];
    applicationPorts.push(...ports);
    Object.assign(environment, {
      CLOUD_PORT: String(api),
      CLOUD_PORTAL_PORT: String(portal),
      CLOUD_ADMIN_PORT: String(admin),
      CLOUD_SERVER_URL: `http://127.0.0.1:${api}`,
      CLOUD_PORTAL_ORIGIN: `http://localhost:${portal}`,
      CLOUD_ADMIN_ORIGIN: `http://localhost:${admin}`,
      CLOUD_DATABASE_URL: e2eDatabase,
    });
    await run([
      'bun',
      '--no-env-file',
      'x',
      '--no-install',
      'playwright',
      'test',
      '--config',
      'platform/portal/playwright.config.ts',
    ]);
  }
  exitCode = 0;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Isolated tests failed');
} finally {
  cleaning = true;
  for (const child of children) await stop(child);
  for (const port of applicationPorts) {
    if (!(await portAvailable(port))) {
      console.error(`Test application port ${port} remains occupied after exit`);
      exitCode = 1;
    }
  }
  if (applicationPorts.length && exitCode === 0)
    console.log(`Verified test application ports released: ${applicationPorts.join(', ')}`);
  if (composeStarted) {
    try {
      await run(
        [...compose, 'down', '--volumes', '--remove-orphans', '--timeout', '10'],
        false,
        true,
      );
      const remaining = await run(
        ['docker', 'ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`],
        true,
        true,
      );
      const volumes = await run(
        ['docker', 'volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`],
        true,
        true,
      );
      if (remaining || volumes) {
        console.error('Owned test resources remain after cleanup');
        exitCode = 1;
      } else console.log(`Cleaned owned test containers and volumes: ${project}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Test cleanup failed');
      exitCode = 1;
    }
  }
  await rm(temporary, { recursive: true, force: true });
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}
process.exitCode = interrupted ? 130 : exitCode;
