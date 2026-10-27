import { cp, mkdir, readFile, readdir, writeFile, chmod, rm, readlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { resolve, join, relative } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import runtimeDependencies from './runtime-dependencies.ts';
const root = resolve(import.meta.dirname, '..');
const repository = resolve(root, '..');
const resources = join(root, 'resources');
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('This resource target is macOS arm64');
await mkdir(resources, { recursive: true });
await mkdir(join(resources, 'node/bin'), { recursive: true });
await cp(process.execPath, join(resources, 'node/bin/node'));
await chmod(join(resources, 'node/bin/node'), 0o755);
if (
  execFileSync(join(resources, 'node/bin/node'), ['--version'], { encoding: 'utf8' }).trim() !==
  'v24.18.0'
)
  throw new Error('The macOS arm64 target requires Node v24.18.0');
const worker = join(repository, 'desktop/analytics-worker/dist/macos-arm64/analytics-worker');
await cp(worker, join(resources, 'worker'), { recursive: true, verbatimSymlinks: true });
await rm(join(resources, 'playwright'), { recursive: true, force: true });
await cp(join(repository, 'desktop/resources/playwright'), join(resources, 'playwright'), {
  recursive: true,
  verbatimSymlinks: true,
});
await mkdir(join(resources, 'runtime'), { recursive: true });
await rm(join(resources, 'runtime/runtime.cjs'), { force: true });
await cp(join(root, 'lib/runtime.mjs'), join(resources, 'runtime/runtime.mjs'));
await cp(join(root, 'lib/profiles'), join(resources, 'runtime/profiles'), { recursive: true });
await cp(
  join(repository, 'tooling/dependency-patches/braces'),
  join(resources, 'runtime/patches/braces'),
  { recursive: true },
);
await cp(
  join(repository, 'tooling/dependency-patches/http-cache-semantics'),
  join(resources, 'runtime/patches/http-cache-semantics'),
  { recursive: true },
);
const yaml = createRequire(join(repository, 'desktop/packages/profiles/catalog/package.json'))(
  'js-yaml',
) as { load(text: string): { overrides?: Record<string, string> } };
const workspaceConfig = yaml.load(await readFile(join(repository, 'pnpm-workspace.yaml'), 'utf8'));
const overrides = {
  ...workspaceConfig.overrides,
  braces: 'file:./patches/braces',
  'http-cache-semantics': 'file:./patches/http-cache-semantics',
};
await writeFile(
  join(resources, 'runtime/package.json'),
  JSON.stringify({
    private: true,
    dependencies: { ...runtimeDependencies, 'better-sqlite3': '13.0.3', playwright: '1.62.1' },
    overrides,
  }),
);
const install = spawnSync(
  'npm',
  ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev', '--workspaces=false'],
  { cwd: join(resources, 'runtime'), stdio: 'inherit' },
);
if (install.status !== 0) throw new Error('Runtime dependency installation failed');
const proxyPatch = await readFile(
  join(repository, 'tooling/dependency-patches/proxy-chain@2.7.1.patch'),
  'utf8',
);
const proxyHash = createHash('sha256').update(proxyPatch).digest('hex');
const proxyDirectory = join(resources, 'runtime/node_modules/proxy-chain');
const proxyVersion = JSON.parse(
  await readFile(join(proxyDirectory, 'package.json'), 'utf8'),
).version;
if (proxyVersion !== '2.7.1')
  throw new Error('Review the proxy-chain lifecycle patch for the new version');
const proxyMarker = join(proxyDirectory, '.zhiyun-patch');
if ((await readFile(proxyMarker, 'utf8').catch(() => '')) !== proxyHash) {
  execFileSync('/usr/bin/patch', ['-p1', '--batch', '--forward'], {
    cwd: proxyDirectory,
    input: proxyPatch,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  await writeFile(proxyMarker, proxyHash);
}
const rebuild = spawnSync('npm', ['rebuild', 'better-sqlite3', '--workspaces=false'], {
  cwd: join(resources, 'runtime'),
  env: { ...process.env, PATH: `${join(resources, 'node/bin')}:${process.env.PATH}` },
  stdio: 'inherit',
});
if (rebuild.status !== 0) throw new Error('Native SQLite build failed');
execFileSync(
  join(resources, 'node/bin/node'),
  ['-e', 'const D=require("better-sqlite3");const d=new D(":memory:");d.close()'],
  { cwd: join(resources, 'runtime'), stdio: 'inherit' },
);
execFileSync(
  '/usr/bin/tar',
  [
    '-czf',
    join(resources, 'runtime/dependencies.tgz'),
    '-C',
    join(resources, 'runtime'),
    'node_modules',
    'patches',
    'package.json',
    'package-lock.json',
  ],
  { stdio: 'inherit' },
);
for (const name of ['worker', 'playwright'])
  execFileSync('/usr/bin/tar', ['-czf', join(resources, `${name}.tgz`), '-C', resources, name], {
    stdio: 'inherit',
  });
await mkdir(join(resources, 'licenses'), { recursive: true });
await cp(join(root, 'licenses/NODE-LICENSE'), join(resources, 'licenses/NODE-LICENSE'));
await cp(
  join(resources, 'playwright/chromium-1234/chrome-mac-arm64/ABOUT'),
  join(resources, 'licenses/CHROMIUM-ABOUT'),
);
await cp(
  join(
    resources,
    'playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/LICENSE.headless_shell',
  ),
  join(resources, 'licenses/CHROMIUM-HEADLESS-LICENSE'),
);
const files: Record<string, string> = {};
const links: Record<string, string> = {};
async function scan(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (['runtime/node_modules', 'worker', 'playwright'].includes(relative(resources, path)))
      continue;
    if (entry.isDirectory()) await scan(path);
    else if (entry.isSymbolicLink()) links[relative(resources, path)] = await readlink(path);
    else if (entry.isFile() && entry.name !== 'manifest.json') {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      files[relative(resources, path)] = hash.digest('hex');
    }
  }
}
await scan(resources);
await writeFile(
  join(resources, 'manifest.json'),
  JSON.stringify(
    {
      platform: 'darwin',
      arch: 'arm64',
      node: execFileSync(join(resources, 'node/bin/node'), ['--version'], {
        encoding: 'utf8',
      }).trim(),
      files,
      links,
      patches: { 'proxy-chain@2.7.1': proxyHash },
    },
    null,
    2,
  ) + '\n',
);
console.log(`Prepared ${Object.keys(files).length} verified resource files`);
