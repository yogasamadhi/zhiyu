import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Type-aware linting retains one TypeScript program per workspace. Use fresh
// processes for each project so the expanded plugin workspaces fit CI memory.
const scan = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});
const files = scan
  .split('\0')
  .filter(
    (file) =>
      existsSync(file) &&
      /\.(?:tsx?|[cm]?js)$/.test(file) &&
      !file.startsWith('vendor/') &&
      !/^tooling\/dependency-patches\/.*\.js$/.test(file),
  );
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
  const child = spawnSync('eslint', [...paths, '--no-warn-ignored'], {
    stdio: 'inherit',
    shell: false,
  });
  if (child.status !== 0) throw new Error(`Lint failed for ${project}`);
}
