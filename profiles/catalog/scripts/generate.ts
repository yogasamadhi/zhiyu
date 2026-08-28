import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createArchitectureCatalog } from '@zhiyun/kernel';
import { format } from 'prettier';
import { resolveProductGraph } from '../src/index.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
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
