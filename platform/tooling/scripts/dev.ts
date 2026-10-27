// Compatibility entry for the canonical platform launcher.
import { spawn } from 'node:child_process';

const child = spawn('pnpm', ['run', 'platform:dev', ...process.argv.slice(2)], {
  stdio: 'inherit',
});
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
