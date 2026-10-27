import { readFile, writeFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
const root = resolve(import.meta.dirname, '..');
const repository = resolve(root, '..');
const packages = new Map<
  string,
  {
    path: string;
    manifest: { name: string; version: string; dependencies?: Record<string, string> };
  }
>();
for (const pattern of [
  'desktop/packages/*/package.json',
  'desktop/packages/plugins/*/package.json',
  'desktop/packages/capabilities/*/package.json',
  'desktop/packages/profiles/*/package.json',
  'vendor/deepseek-harness/vendor/*/package.json',
])
  for await (const path of glob(pattern, { cwd: repository })) {
    const manifest = JSON.parse(await readFile(resolve(repository, path), 'utf8'));
    packages.set(manifest.name, { path: resolve(repository, path), manifest });
  }
const dependencies: Record<string, string> = {};
const seen = new Set<string>();
async function visit(name: string, from: string) {
  if (seen.has(name)) return;
  seen.add(name);
  const workspace = packages.get(name);
  if (workspace) {
    for (const dependency of Object.keys(workspace.manifest.dependencies ?? {}))
      await visit(dependency, workspace.path);
    return;
  }
  if (name === 'react' || name === 'react-dom') {
    dependencies[name] = '18.3.1';
    return;
  }
  const require = createRequire(from);
  let entry: string;
  try {
    entry = require.resolve(`${name}/package.json`);
  } catch {
    // Some packages publish only ESM entry points and hide their manifest from
    // the export map, so the installed tree is searched instead.
    entry = installedManifest(name, from);
  }
  const manifest = JSON.parse(await readFile(entry, 'utf8'));
  if (manifest.name !== name) throw new Error(`Wrong package metadata: ${name}: ${entry}`);
  dependencies[name] = manifest.version;
}

function installedManifest(name: string, from: string): string {
  let directory = dirname(from);
  for (;;) {
    const candidate = join(directory, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`No package metadata for ${name}`);
    directory = parent;
  }
}
await visit('@zhiyun/runtime', join(root, 'package.json'));
await writeFile(
  join(root, 'runtime-dependencies.json'),
  JSON.stringify(dependencies, null, 2) + '\n',
);
export default dependencies;
