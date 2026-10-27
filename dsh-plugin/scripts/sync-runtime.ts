import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
await copyFile('dsh-plugin/lib/runtime.mjs', 'dsh-plugin/resources/runtime/runtime.mjs');
const manifest = JSON.parse(await readFile('dsh-plugin/resources/manifest.json', 'utf8'));
manifest.files['runtime/runtime.mjs'] = createHash('sha256')
  .update(await readFile('dsh-plugin/resources/runtime/runtime.mjs'))
  .digest('hex');
await writeFile('dsh-plugin/resources/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
