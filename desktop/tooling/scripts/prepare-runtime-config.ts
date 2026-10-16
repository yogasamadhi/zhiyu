import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const desktop = resolve(import.meta.dir, '../..');
const source = resolve(desktop, 'packages/profiles/catalog/config');
for (const path of [
  'packages/runtime/dist/profiles',
  'dist/runtime/profiles',
  'packages/profiles/catalog/dist/config',
]) {
  const target = resolve(desktop, path);
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true, force: true });
}
