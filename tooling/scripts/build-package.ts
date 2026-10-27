import { resolve } from 'node:path';
import { build } from 'esbuild';

// Shared package bundler. The command line mirrors the original build
// invocations so every workspace package keeps an explicit, reviewable build
// configuration instead of a hidden bundler default.
//
// Usage: build-package.ts <entry...> [--outdir <dir>] [--outfile <file>]
//        [--target node|browser] [--format esm|cjs] [--packages external|bundle]
//        [--root <dir>] [--external <package>]
interface Options {
  entries: string[];
  outdir?: string | undefined;
  outfile?: string | undefined;
  target?: 'node' | 'browser' | undefined;
  format?: 'esm' | 'cjs' | undefined;
  packages?: 'external' | 'bundle' | undefined;
  root?: string | undefined;
  external: string[];
}

const options: Options = { entries: [], external: [] };
const arguments_ = process.argv.slice(2);
for (let index = 0; index < arguments_.length; index++) {
  const argument = arguments_[index]!;
  const value = () => {
    const next = arguments_[index + 1];
    if (next === undefined) throw new Error(`Missing value for ${argument}`);
    index += 1;
    return next;
  };
  switch (argument) {
    case '--outdir':
      options.outdir = value();
      break;
    case '--outfile':
      options.outfile = value();
      break;
    case '--target':
      options.target = value() as Options['target'];
      break;
    case '--format':
      options.format = value() as Options['format'];
      break;
    case '--packages':
      options.packages = value() as Options['packages'];
      break;
    case '--root':
      options.root = value();
      break;
    case '--external':
      options.external.push(value());
      break;
    default:
      if (argument.startsWith('--')) throw new Error(`Unknown build option ${argument}`);
      options.entries.push(argument);
  }
}
if (!options.entries.length) throw new Error('At least one entry point is required');
if (!options.outdir && !options.outfile) throw new Error('An output directory or file is required');

await build({
  entryPoints: options.entries.map((entry) => resolve(entry)),
  ...(options.outdir ? { outdir: resolve(options.outdir) } : {}),
  ...(options.outfile ? { outfile: resolve(options.outfile) } : {}),
  ...(options.root ? { outbase: resolve(options.root) } : {}),
  platform: options.target === 'browser' ? 'browser' : 'node',
  format: options.format === 'cjs' ? 'cjs' : 'esm',
  bundle: true,
  ...(options.packages === 'external' ? { packages: 'external' } : {}),
  ...(options.external.length ? { external: options.external } : {}),
  jsx: 'automatic',
  splitting: false,
  logLevel: 'warning',
  // Workspace packages import their upstream Cordis typings with a value import
  // that keeps the module load. The vendored packages declare no side effects,
  // so esbuild reports the dropped import for every plugin entry.
  logOverride: { 'ignored-bare-import': 'silent' },
});
