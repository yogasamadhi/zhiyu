import { testEnvironment } from '../../../tooling/scripts/test-environment.js';

const mode = process.argv[2];
const files = process.argv.slice(3);
const directory = mode === 'packaged' ? 'e2e-packaged' : 'e2e';
if (
  !['development', 'packaged'].includes(mode ?? '') ||
  files.some((file) => !new RegExp(`^${directory}/[a-z0-9-]+\\.spec\\.ts$`).test(file))
)
  throw new Error(
    'Usage: bun --no-env-file desktop/tooling/scripts/test-e2e-isolated.ts development|packaged [e2e[-packaged]/name.spec.ts ...]',
  );
const environment = testEnvironment(process.env);
const tasks = mode === 'packaged' ? ['package', 'test:packaged'] : ['test'];
for (const task of tasks) {
  const child = Bun.spawn(
    [
      'bun',
      '--no-env-file',
      'run',
      '--filter',
      '@zhiyun/desktop',
      task,
      ...(task === 'package' ? [] : files),
    ],
    {
      env: environment,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
  const code = await child.exited;
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}
