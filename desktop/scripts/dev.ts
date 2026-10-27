import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const desktopRoot = resolve(import.meta.dirname, '..');
const workspaceRoot = resolve(desktopRoot, '..');
const rendererPort = Number(process.env.DESKTOP_RENDERER_PORT ?? 45174);
const rendererUrl = `http://127.0.0.1:${rendererPort}`;

function run(command: string[], cwd = workspaceRoot): void {
  const child = spawnSync(command[0]!, command.slice(1), {
    cwd,
    stdio: 'inherit',
  });
  if (child.status !== 0)
    throw new Error(`${command.join(' ')} exited with ${child.status ?? 'unknown'}`);
}

const sleep = (milliseconds: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

run(['pnpm', 'exec', 'tsx', 'scripts/build.ts'], desktopRoot);
const vite = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1'], {
  cwd: desktopRoot,
  stdio: ['ignore', 'inherit', 'inherit'],
});
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    if ((await fetch(rendererUrl)).ok) break;
  } catch {
    await sleep(100);
  }
}
const electron = spawn('pnpm', ['exec', 'electron', '.'], {
  cwd: desktopRoot,
  env: { ...process.env, ZHIYUN_DESKTOP_DEV_URL: rendererUrl },
  stdio: 'inherit',
});
const exitCode = await new Promise<number>((resolve) => {
  electron.on('exit', (code) => resolve(code ?? 0));
});
vite.kill('SIGTERM');
process.exit(exitCode);
