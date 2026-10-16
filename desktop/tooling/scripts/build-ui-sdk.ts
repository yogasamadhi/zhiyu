import { resolve } from 'node:path';
const source = resolve(process.cwd(), 'src');
const entrypoints = [...new Bun.Glob('**/*.{ts,tsx}').scanSync(source)]
  .filter((path) => !path.endsWith('.d.ts'))
  .map((path) => resolve(source, path));
const result = await Bun.build({
  entrypoints,
  root: source,
  outdir: resolve(process.cwd(), 'dist'),
  naming: {
    entry: '[dir]/[name].[ext]',
    chunk: 'chunks/[name]-[hash].[ext]',
    asset: 'assets/[name]-[hash].[ext]',
  },
  target: 'browser',
  format: 'esm',
  packages: 'external',
});
if (!result.success) throw new AggregateError(result.logs, 'UI SDK build failed');
