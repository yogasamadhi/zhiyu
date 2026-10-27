import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '../../../..');
const vendor = resolve(root, 'vendor/deepseek-harness/vendor');
const packages = [
  'cosmokit',
  'schemastery',
  'cordis',
  'loader',
  'include',
  'group',
  'timer',
  'logger-console',
];
const stamp = resolve(root, '.artifacts/cordis-build.json');
const lock = JSON.parse(await readFile(resolve(vendor, '../../vendor.lock.json'), 'utf8')) as {
  vendors: { name: string; revision: string }[];
};
const revision = lock.vendors.find(({ name }) => name === 'deepseek-harness')?.revision;
if (!revision || !existsSync(resolve(vendor, 'cordis/src/index.ts')))
  throw new Error('Initialize the pinned DSH submodule: git submodule update --init --recursive');
const actualRevision = execFileSync('git', ['-C', resolve(vendor, '..'), 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
if (actualRevision !== revision) throw new Error('DSH checkout does not match vendor.lock.json');
const fingerprint = createHash('sha256')
  .update(revision)
  .update(await readFile(import.meta.filename))
  .update(await readFile(resolve(import.meta.dirname, 'browser-adapter.json')))
  .update(await readFile(resolve(root, 'pnpm-lock.yaml')))
  .digest('hex');
if (
  existsSync(resolve(root, '.artifacts/cordis/loader-browser.js')) &&
  existsSync(stamp) &&
  JSON.parse(await readFile(stamp, 'utf8')).fingerprint === fingerprint &&
  packages.every(
    (name) =>
      existsSync(
        resolve(vendor, name, name === 'schemastery' ? 'lib/index.mjs' : 'lib/index.js'),
      ) &&
      (existsSync(resolve(vendor, name, 'lib/types/index.d.ts')) ||
        (name === 'logger-console' && existsSync(resolve(vendor, name, 'lib/types/shared.d.ts')))),
  )
)
  process.exit(0);
execFileSync(
  process.execPath,
  [
    resolve(root, 'node_modules/typescript/bin/tsc'),
    '-b',
    ...packages.map((name) => resolve(vendor, name)),
  ],
  { cwd: root, stdio: 'inherit' },
);
for (const name of packages) {
  // The vendored packages export const enums at runtime. Match those exports in
  // generated declarations so isolatedModules consumers do not compile vendor sources.
  await normalizeDeclarations(resolve(vendor, name, 'lib/types'));
  const entries = name === 'logger-console' ? ['index', 'browser'] : ['index'];
  for (const entry of entries) {
    for (const format of name === 'schemastery' ? (['esm', 'cjs'] as const) : (['esm'] as const)) {
      await build({
        entryPoints: [resolve(vendor, name, `src/${entry}.ts`)],
        tsconfig: resolve(root, 'tsconfig.base.json'),
        outdir: resolve(vendor, name, 'lib'),
        entryNames: '[name]',
        outExtension: { '.js': format === 'esm' ? '.mjs' : '.cjs' },
        platform: entry === 'browser' ? 'browser' : 'node',
        format,
        bundle: true,
        packages: 'external',
      });
    }
  }
}
await mkdir(resolve(root, '.artifacts'), { recursive: true });

async function normalizeDeclarations(directory: string): Promise<void> {
  for (const file of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, file.name);
    if (file.isDirectory()) await normalizeDeclarations(path);
    else if (file.name.endsWith('.d.ts')) {
      const source = await readFile(path, 'utf8');
      await writeFile(path, source.replace(/declare const enum/g, 'declare enum'));
    }
  }
}

// DSH's Loader runs in browsers; this build removes the Node probe and the eager
// Function constructor required by host-side !!js expressions. The renderer
// receives plain manifests and retains script-src 'self'. Source hashes fail
// closed on a vendor update so compatibility changes receive explicit review.
const adapter = JSON.parse(
  await readFile(resolve(import.meta.dirname, 'browser-adapter.json'), 'utf8'),
) as { revision: string; sha256: Record<string, string> };
if (adapter.revision !== revision)
  throw new Error('Review the Cordis browser adapter for the new vendor revision');
for (const [path, expected] of Object.entries(adapter.sha256)) {
  if (
    createHash('sha256')
      .update(await readFile(resolve(vendor, path)))
      .digest('hex') !== expected
  )
    throw new Error(`Cordis browser adapter source changed: ${path}`);
}
await build({
  entryPoints: [resolve(vendor, 'loader/src/index.ts')],
  outdir: resolve(root, '.artifacts/cordis'),
  entryNames: 'loader-browser',
  format: 'esm',
  platform: 'browser',
  bundle: true,
  packages: 'external',
  tsconfig: resolve(root, 'tsconfig.base.json'),
  define: { 'process.env.CORDIS_SHARED': 'undefined' },
  plugins: [
    {
      name: 'packaged-cordis-browser',
      setup(build) {
        build.onLoad({ filter: /loader\/src\/internal\.ts$/ }, () => ({
          contents: 'export const ModuleLoader = { fromInternal() { return undefined; } };',
          loader: 'ts',
        }));
        build.onLoad({ filter: /loader\/src\/config\/utils\.ts$/ }, async ({ path }) => {
          const source = await readFile(path, 'utf8');
          const contents = source.replace(
            /export const evaluate = new Function[\s\S]*?as \(\(ctx: object, expr: string\) => any\)/,
            'export function evaluate(_ctx: object, _expr: string): never { throw new Error("JavaScript configuration expressions are host-only"); }',
          );
          if (contents === source)
            throw new Error('Cordis browser evaluator adapter did not match');
          return { contents, loader: 'ts' };
        });
      },
    },
  ],
});

await writeFile(stamp, JSON.stringify({ fingerprint, revision }));
