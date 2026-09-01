import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error('The Headless release must be assembled on Linux x64');
}

const apiRoot = resolve(import.meta.dirname, '..');
const workspaceRoot = resolve(apiRoot, '../..');
const outputRoot = resolve(apiRoot, 'dist/headless');
const releaseRoot = resolve(outputRoot, 'linux-x64');
const archive = resolve(outputRoot, 'zhiyun-headless-1.0.0-linux-x64.tar.gz');
const workerSource = resolve(
  workspaceRoot,
  'services/analytics-worker/dist/linux-x64/analytics-worker',
);
const webSource = resolve(workspaceRoot, 'apps/web/dist');
if (!(await stat(workerSource).catch(() => undefined))?.isDirectory()) {
  throw new Error(`Linux Analytics Worker is missing: ${workerSource}`);
}

await rm(releaseRoot, { recursive: true, force: true });
await rm(archive, { force: true });
await mkdir(releaseRoot, { recursive: true });
await run(['bun', 'run', 'compliance:licenses']);
await run(['bun', 'run', '--filter', '@zhiyun/web', 'build']);

await run([
  'bun',
  'build',
  resolve(apiRoot, 'src/server.ts'),
  '--compile',
  '--target=bun-linux-x64-modern',
  `--outfile=${resolve(releaseRoot, 'zhiyun-api')}`,
  '--packages=bundle',
  '--external=better-sqlite3',
  '--external=playwright',
]);

const workerTarget = resolve(releaseRoot, 'analytics-worker/linux-x64/analytics-worker');
await mkdir(resolve(releaseRoot, 'analytics-worker/linux-x64'), { recursive: true });
await cp(workerSource, workerTarget, { recursive: true });
await cp(webSource, resolve(releaseRoot, 'web'), { recursive: true });
await cp(resolve(workspaceRoot, 'dist/compliance'), resolve(releaseRoot, 'compliance'), {
  recursive: true,
});
await writeFile(
  resolve(releaseRoot, 'package.json'),
  JSON.stringify(
    {
      name: 'zhiyun-headless-runtime',
      version: '1.0.0',
      private: true,
      dependencies: {
        'better-sqlite3': '13.0.3',
        playwright: '1.62.1',
        'playwright-core': '1.62.1',
      },
    },
    null,
    2,
  ),
);
await run(['bun', 'install', '--production', '--linker=hoisted'], releaseRoot);

const checksums = await Promise.all(
  [
    'zhiyun-api',
    'analytics-worker/linux-x64/analytics-worker/analytics-worker',
    'web/index.html',
  ].map(async (relativePath) => {
    const digest = createHash('sha256')
      .update(await readFile(resolve(releaseRoot, relativePath)))
      .digest('hex');
    return `${digest}  ${relativePath}`;
  }),
);
await writeFile(resolve(releaseRoot, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
await writeFile(
  resolve(releaseRoot, 'README.txt'),
  [
    'ZhiYun Headless 1.0.0 (Linux x64)',
    '',
    'Run ./zhiyun-api with PostgreSQL and Redis connection settings from .env.example.',
    'The Web UI is bundled under web/ and served from the same Origin as the API.',
    'The supervised Python Analytics Worker is bundled under analytics-worker/.',
    'Chromium is supplied by the deployment image or PLAYWRIGHT_BROWSERS_PATH.',
    'Third-party license records are bundled under compliance/.',
    '',
  ].join('\n'),
);
await run(['tar', '-czf', archive, '-C', outputRoot, 'linux-x64']);

async function run(command: string[], cwd = workspaceRoot): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(' ')} exited with ${exitCode}`);
}
