import { spawnSync } from 'node:child_process';
import { testEnvironment } from '../../../tooling/scripts/test-environment.js';

const mode = process.argv[2];
const files = process.argv.slice(3);
const directory = mode === 'packaged' ? 'e2e-packaged' : 'e2e';
if (
  !['development', 'packaged'].includes(mode ?? '') ||
  files.some((file) => !new RegExp(`^${directory}/[a-z0-9-]+\\.spec\\.ts$`).test(file))
)
  throw new Error(
    'Usage: node desktop/tooling/scripts/test-e2e-isolated.ts development|packaged [e2e[-packaged]/name.spec.ts ...]',
  );
const environment = testEnvironment(process.env);
const tasks = mode === 'packaged' ? ['package', 'test:packaged'] : ['test'];
for (const task of tasks) {
  const child = spawnSync(
    'pnpm',
    ['--filter', '@zhiyun/desktop', task, ...(task === 'package' ? [] : files)],
    {
      env: environment,
      stdio: 'inherit',
    },
  );
  const code = child.status ?? 1;
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}
