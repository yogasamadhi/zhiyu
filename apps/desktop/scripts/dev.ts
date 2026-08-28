import { resolve } from 'node:path';

const desktopRoot = resolve(import.meta.dir, '..');
const workspaceRoot = resolve(desktopRoot, '../..');
const rendererPort = Number(process.env.DESKTOP_RENDERER_PORT ?? 45174);
const rendererUrl = `http://127.0.0.1:${rendererPort}`;

async function run(command: string[], cwd = workspaceRoot): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(' ')} exited with ${exitCode}`);
}

await run(['bun', 'scripts/build.ts'], desktopRoot);
const vite = Bun.spawn(['bun', '--bun', 'vite', '--host', '127.0.0.1'], {
  cwd: desktopRoot,
  stdout: 'inherit',
  stderr: 'inherit',
});
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    if ((await fetch(rendererUrl)).ok) break;
  } catch {
    await Bun.sleep(100);
  }
}
const electron = Bun.spawn(['bunx', 'electron', '.'], {
  cwd: desktopRoot,
  env: { ...process.env, ZHIYUN_DESKTOP_DEV_URL: rendererUrl },
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
const exitCode = await electron.exited;
vite.kill('SIGTERM');
process.exit(exitCode);
