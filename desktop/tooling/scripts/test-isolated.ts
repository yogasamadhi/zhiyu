import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { testEnvironment } from '../../../tooling/scripts/test-environment.js';
const directory = await mkdtemp(join(tmpdir(), 'zhiyun-runtime-test-'));
let code: number;
try {
  const child = spawnSync('vitest', ['run', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: {
      ...testEnvironment(process.env),
      ...(process.env.ZHIYUN_PERFORMANCE === '1' ? { ZHIYUN_PERFORMANCE: '1' } : {}),
      ZHIYUN_DATA_DIR: directory,
      CRAWLEE_STORAGE_DIR: join(directory, 'crawlee'),
    },
  });
  code = child.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
process.exitCode = code;
