import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const node = JSON.parse(
  await readFile(resolve(root, '../.artifacts/compliance/node.json'), 'utf8'),
);
const python = JSON.parse(
  await readFile(resolve(root, '../.artifacts/compliance/python.json'), 'utf8'),
);
const manifest = JSON.parse(await readFile(join(root, 'resources/manifest.json'), 'utf8'));
const extra = [];
for (const name of [
  '@deepseek-ai/dsh',
  '@deepseek-ai/cordis',
  'zod',
  'react',
  'react-dom',
  '@tanstack/react-query',
  'react-router-dom',
]) {
  const p = JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'));
  extra.push({ name: p.name, version: p.version, license: p.license });
}
await writeFile(
  join(root, 'THIRD_PARTY_NOTICES.json'),
  JSON.stringify(
    {
      formatVersion: 1,
      generatedFor: 'dsh-zhiyun 0.1.0',
      target: 'darwin-arm64',
      resourceVersions: {
        node: manifest.node,
        sqlite: '13.0.3',
        playwright: '1.62.1',
        dsh: '0.2.1-rc.3',
      },
      notice:
        'Repository dependency notices are a conservative superset of bundled JavaScript dependencies. Python notices accompany the frozen worker. Chromium and Node license files are retained in resources/licenses.',
      hostAndClient: extra,
      node: node.packages,
      python: python.packages,
    },
    null,
    2,
  ) + '\n',
);
// Include the exact external dependency versions installed into the private runtime.
const { readdir } = await import('node:fs/promises');
const runtimePackages: Array<{
  name: string;
  version: string;
  license: unknown;
  notices: Record<string, string>;
}> = [];
async function dependencies(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    if (entry.name.startsWith('@')) {
      await dependencies(path);
      continue;
    }
    const metadata = await readFile(join(path, 'package.json'), 'utf8').catch(() => null);
    if (!metadata) continue;
    const p = JSON.parse(metadata);
    const notices: Record<string, string> = {};
    for (const file of await readdir(path, { withFileTypes: true }))
      if (file.isFile() && /^(?:licen[cs]e|copying|notice)(?:[.\-_]|$)/i.test(file.name))
        notices[file.name] = await readFile(join(path, file.name), 'utf8');
    runtimePackages.push({ name: p.name, version: p.version, license: p.license ?? null, notices });
    await dependencies(join(path, 'node_modules')).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
await dependencies(join(root, 'resources/runtime/node_modules'));
const notices = JSON.parse(await readFile(join(root, 'THIRD_PARTY_NOTICES.json'), 'utf8'));
notices.runtimePackages = runtimePackages;
await writeFile(join(root, 'THIRD_PARTY_NOTICES.json'), JSON.stringify(notices, null, 2) + '\n');
