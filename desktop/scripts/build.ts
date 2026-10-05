import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const desktopRoot = resolve(import.meta.dir, '..');
const workspaceRoot = resolve(desktopRoot, '..');

async function run(command: string[], cwd = workspaceRoot): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(' ')} exited with ${exitCode}`);
}

for (const workspace of ['@zhiyun/shared', '@zhiyun/contracts', '@zhiyun/client', '@zhiyun/ui']) {
  await run(['bun', 'run', '--filter', workspace, 'build']);
}
await run(['bun', 'run', '--filter', '@zhiyun/runtime', 'build']);
const result = await Bun.build({
  entrypoints: [resolve(desktopRoot, 'src/main.ts')],
  outdir: resolve(desktopRoot, 'dist'),
  target: 'node',
  format: 'esm',
  packages: 'bundle',
  external: ['electron'],
  sourcemap: 'external',
});
if (!result.success) throw new AggregateError(result.logs, 'Electron Main/Preload build failed');
const preloadResult = await Bun.build({
  entrypoints: [
    resolve(desktopRoot, 'src/preload.ts'),
    resolve(desktopRoot, 'src/credential-preload.ts'),
  ],
  outdir: resolve(desktopRoot, 'dist'),
  naming: '[name].cjs',
  target: 'node',
  format: 'cjs',
  packages: 'bundle',
  external: ['electron'],
  sourcemap: 'external',
});
if (!preloadResult.success)
  throw new AggregateError(preloadResult.logs, 'Electron Preload build failed');
await mkdir(resolve(desktopRoot, 'dist/runtime'), { recursive: true });
await copyFile(
  resolve(desktopRoot, 'packages/runtime/dist/utility-entry.js'),
  resolve(desktopRoot, 'dist/runtime/utility-entry.js'),
);
await run(['bun', '--bun', 'vite', 'build'], desktopRoot);

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
