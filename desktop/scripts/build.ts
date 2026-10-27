import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const desktopRoot = resolve(import.meta.dirname, '..');
const workspaceRoot = resolve(desktopRoot, '..');

function run(command: string[], cwd = workspaceRoot): void {
  const child = spawnSync(command[0]!, command.slice(1), {
    cwd,
    stdio: 'inherit',
  });
  if (child.status !== 0)
    throw new Error(`${command.join(' ')} exited with ${child.status ?? 'unknown'}`);
}

run(['pnpm', 'run', 'vendor:prepare']);
for (const workspace of ['@zhiyun/shared', '@zhiyun/contracts', '@zhiyun/client', '@zhiyun/ui']) {
  run(['pnpm', '--filter', workspace, 'build']);
}
run(['pnpm', '--filter', '@zhiyun/runtime', 'build']);
await build({
  entryPoints: [resolve(desktopRoot, 'src/main.ts')],
  outdir: resolve(desktopRoot, 'dist'),
  platform: 'node',
  format: 'esm',
  bundle: true,
  external: ['electron'],
  sourcemap: 'external',
  logLevel: 'warning',
});
await build({
  entryPoints: {
    preload: resolve(desktopRoot, 'src/preload.ts'),
    'credential-preload': resolve(desktopRoot, 'src/credential-preload.ts'),
  },
  outdir: resolve(desktopRoot, 'dist'),
  entryNames: '[name]',
  outExtension: { '.js': '.cjs' },
  platform: 'node',
  format: 'cjs',
  bundle: true,
  external: ['electron'],
  sourcemap: 'external',
  logLevel: 'warning',
});
await mkdir(resolve(desktopRoot, 'dist/runtime'), { recursive: true });
await copyFile(
  resolve(desktopRoot, 'packages/runtime/dist/utility-entry.js'),
  resolve(desktopRoot, 'dist/runtime/utility-entry.js'),
);
run(['pnpm', 'exec', 'vite', 'build'], desktopRoot);

const rendererRoot = resolve(desktopRoot, 'dist/renderer');
for (const file of await rendererFiles(rendererRoot)) {
  const source = await readFile(file, 'utf8');
  if (/https?:\/\/(?:127\.0\.0\.1|localhost):45100/u.test(source)) {
    throw new Error(`Production Renderer contains a development fixture URL: ${file}`);
  }
}

async function rendererFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await rendererFiles(path)));
    else if (/\.(?:css|html|js|json|map)$/u.test(entry.name)) result.push(path);
  }
  return result;
}
