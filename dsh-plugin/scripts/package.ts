import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const stage = join(root, 'out/package');
for (const script of ['build.ts', 'resources.ts', 'licenses.ts']) {
  const child = spawnSync('pnpm', ['exec', 'tsx', join(root, 'scripts', script)], {
    cwd: resolve(root, '..'),
    stdio: 'inherit',
  });
  if (child.status !== 0) throw new Error(`${script} failed`);
}
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
delete manifest.devDependencies;
delete manifest.scripts;
manifest.os = ['darwin'];
manifest.cpu = ['arm64'];
await writeFile(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
for (const name of [
  'lib',
  'resources',
  'cordis.patch.yml',
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.json',
])
  await cp(join(root, name), join(stage, name), {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) =>
      !source.includes('/runtime/node_modules') &&
      !source.startsWith(join(root, 'resources/worker') + '/') &&
      source !== join(root, 'resources/worker') &&
      !source.startsWith(join(root, 'resources/playwright') + '/') &&
      source !== join(root, 'resources/playwright'),
  });
const pack = spawnSync(
  'npm',
  ['pack', '--workspaces=false', '--pack-destination', join(root, 'out')],
  { cwd: stage, stdio: 'inherit' },
);
if (pack.status !== 0) throw new Error('Packaging failed');
