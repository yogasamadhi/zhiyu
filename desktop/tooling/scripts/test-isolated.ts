import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testEnvironment } from '../../../tooling/scripts/test-environment.js';
const directory = await mkdtemp(join(tmpdir(), 'zhiyun-runtime-test-'));
let code: number;
try {
  const command = [
    'bun',
    '--no-env-file',
    'x',
    '--no-install',
    'vitest',
    'run',
    ...process.argv.slice(2),
  ];
  const child = Bun.spawn(command, {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...testEnvironment(process.env),
      ...(process.env.ZHIYUN_PERFORMANCE === '1' ? { ZHIYUN_PERFORMANCE: '1' } : {}),
      ZHIYUN_DATA_DIR: directory,
      CRAWLEE_STORAGE_DIR: join(directory, 'crawlee'),
    },
  });
  code = await child.exited;
} finally {
  await rm(directory, { recursive: true, force: true });
}
process.exitCode = code;
