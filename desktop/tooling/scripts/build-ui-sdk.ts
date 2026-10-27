import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const source = resolve(process.cwd(), 'src');
const entrypoints: string[] = [];
const walk = async (directory: string): Promise<void> => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) entrypoints.push(path);
  }
};
await walk(source);
await build({
  entryPoints: entrypoints,
  outbase: source,
  outdir: resolve(process.cwd(), 'dist'),
  entryNames: '[dir]/[name]',
  chunkNames: 'chunks/[name]-[hash]',
  assetNames: 'assets/[name]-[hash]',
  platform: 'browser',
  format: 'esm',
  bundle: true,
  packages: 'external',
  jsx: 'automatic',
  splitting: false,
  logLevel: 'warning',
});
