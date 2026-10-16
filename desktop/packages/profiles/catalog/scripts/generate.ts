import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createArchitectureCatalog } from '@zhiyun/plugin-runtime';
import { format } from 'prettier';
import { clientManifest, productProfiles, resolveProductGraph } from '../src/index.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const target = resolve(projectRoot, 'docs/generated/architecture-catalog.json');
const graph = resolveProductGraph('desktop-studio');
const serialized = await format(JSON.stringify(createArchitectureCatalog(graph)), {
  parser: 'json',
});

if (process.argv.includes('--check')) {
  const current = await readFile(target, 'utf8').catch(() => '');
  if (current !== serialized) {
    process.stderr.write(
      'Architecture catalog is out of date. Run bun run architecture:generate.\n',
    );
    process.exit(1);
  }
} else {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, serialized);
}

const clientTarget = resolve(projectRoot, 'desktop/packages/ui/src/generated/client-profiles.json');
const clientSerialized = await format(
  JSON.stringify(Object.fromEntries(productProfiles.map(({ id }) => [id, clientManifest(id)]))),
  { parser: 'json' },
);
if (process.argv.includes('--check')) {
  if ((await readFile(clientTarget, 'utf8').catch(() => '')) !== clientSerialized)
    throw new Error('Client Cordis manifests are out of date. Run bun run architecture:generate.');
} else {
  await mkdir(dirname(clientTarget), { recursive: true });
  await writeFile(clientTarget, clientSerialized);
}
