import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Type-aware linting retains one TypeScript program per workspace. Use fresh
// processes for each project so the expanded plugin workspaces fit CI memory.
const scan = Bun.spawn(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  stdout: 'pipe',
  stderr: 'inherit',
});
const files = (await new Response(scan.stdout).text())
  .split('\0')
  .filter(
    (file) =>
      existsSync(file) &&
      /\.(?:tsx?|[cm]?js)$/.test(file) &&
      !file.startsWith('desktop/tooling/dependencies/vendor/') &&
      !/^tooling\/dependency-patches\/.*\.js$/.test(file),
  );
if (await scan.exited) throw new Error('Cannot enumerate lint inputs');
const root = process.cwd();
const groups = new Map<string, string[]>();
for (const file of files) {
  let directory = dirname(resolve(root, file));
  while (directory !== root && !existsSync(resolve(directory, 'tsconfig.json')))
    directory = dirname(directory);
  const group = groups.get(directory) ?? [];
  group.push(file);
  groups.set(directory, group);
}
for (const [project, paths] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
  const child = Bun.spawn(['bun', 'x', '--no-install', 'eslint', ...paths, '--no-warn-ignored'], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (await child.exited) throw new Error(`Lint failed for ${project}`);
}
