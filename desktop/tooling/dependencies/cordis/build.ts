import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dir, '../../../..');
const vendor = resolve(root, 'desktop/tooling/dependencies/vendor/deepseek-harness/vendor');
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
const git = Bun.spawn(['git', '-C', resolve(vendor, '..'), 'rev-parse', 'HEAD'], {
  stdout: 'pipe',
  stderr: 'pipe',
});
const actualRevision = (await new Response(git.stdout).text()).trim();
if ((await git.exited) || actualRevision !== revision)
  throw new Error('DSH checkout does not match vendor.lock.json');
const fingerprint = createHash('sha256')
  .update(revision)
  .update(await readFile(import.meta.filename))
  .update(await readFile(resolve(import.meta.dir, 'browser-adapter.json')))
  .update(await readFile(resolve(root, 'bun.lock')))
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
const child = Bun.spawn(
  ['bun', 'x', '--no-install', 'tsc', '-b', ...packages.map((name) => resolve(vendor, name))],
  { cwd: root, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
);
if (await child.exited) throw new Error('Cordis declarations build failed');
for (const name of packages) {
  // Bun exports const enums at runtime. Match those exports in generated declarations
  // so isolatedModules consumers do not need to compile vendor sources.
  await normalizeDeclarations(resolve(vendor, name, 'lib/types'));
  const entries = name === 'logger-console' ? ['index', 'browser'] : ['index'];
  for (const entry of entries) {
    for (const format of name === 'schemastery' ? (['esm', 'cjs'] as const) : (['esm'] as const)) {
      const result = await Bun.build({
        entrypoints: [resolve(vendor, name, `src/${entry}.ts`)],
        tsconfig: resolve(root, 'tsconfig.base.json'),
        outdir: resolve(vendor, name, 'lib'),
        naming: name === 'schemastery' ? `[name].${format === 'esm' ? 'mjs' : 'cjs'}` : '[name].js',
        target: entry === 'browser' ? 'browser' : 'node',
        format,
        packages: 'external',
      });
      if (!result.success)
        throw new AggregateError(result.logs, `Cordis ${name}/${entry} build failed`);
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
  await readFile(resolve(import.meta.dir, 'browser-adapter.json'), 'utf8'),
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
const browserLoader = await Bun.build({
  entrypoints: [resolve(vendor, 'loader/src/index.ts')],
  outdir: resolve(root, '.artifacts/cordis'),
  naming: 'loader-browser.js',
  format: 'esm',
  target: 'browser',
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
if (!browserLoader.success)
  throw new AggregateError(browserLoader.logs, 'Cordis browser Loader build failed');

await writeFile(stamp, JSON.stringify({ fingerprint, revision }));
