import { readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { build, type Plugin, type PluginBuild } from 'esbuild';

// Shared package bundler. The command line mirrors the original build
// invocations so every workspace package keeps an explicit, reviewable build
// configuration instead of a hidden bundler default.
//
// Usage: build-package.ts <entry...> [--outdir <dir>] [--outfile <file>]
//        [--target node|browser] [--format esm|cjs] [--packages external|bundle]
//        [--root <dir>] [--external <package>] [--node-runtime]
interface Options {
  entries: string[];
  outdir?: string | undefined;
  outfile?: string | undefined;
  target?: 'node' | 'browser' | undefined;
  format?: 'esm' | 'cjs' | undefined;
  packages?: 'external' | 'bundle' | undefined;
  root?: string | undefined;
  external: string[];
  nodeRuntime: boolean;
}

const options: Options = { entries: [], external: [], nodeRuntime: false };
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
    case '--node-runtime':
      options.nodeRuntime = true;
      break;
    default:
      if (argument.startsWith('--')) throw new Error(`Unknown build option ${argument}`);
      options.entries.push(argument);
  }
}
if (!options.entries.length) throw new Error('At least one entry point is required');
if (!options.outdir && !options.outfile) throw new Error('An output directory or file is required');

// Node ESM bundles keep CommonJS dependencies that call `require` and
// `__dirname` at runtime (for example `ow` and the Playwright plugin inside
// `@crawlee/*`). esbuild rewrites those calls to helpers that throw unless the
// matching bindings exist, so the bundle needs Node shims to stay loadable
// outside Bun.
const nodeEsmBanner = {
  js: [
    'import { createRequire as zhCreateRequire } from "node:module";',
    'import { fileURLToPath as zhFileURLToPath } from "node:url";',
    'import { dirname as zhDirname } from "node:path";',
    'const require = zhCreateRequire(import.meta.url);',
    'const __filename = zhFileURLToPath(import.meta.url);',
    'const __dirname = zhDirname(__filename);',
  ].join('\n'),
};

// Node keeps CommonJS semantics that a bundler has to reproduce explicitly:
// `__dirname` and `__filename` belong to the module that declares them, and
// `require.resolve()` returns a real path. esbuild only rewrites those calls
// into helpers that throw inside an ESM bundle, so the bundler restores them
// while loading each CommonJS module.
const nodeCommonJsSemantics: Plugin = {
  name: 'node-commonjs-semantics',
  setup(bundler) {
    bundler.onLoad({ filter: /\.[cm]?js$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      if (!(await isCommonJsModule(args.path, source))) return null;
      return {
        contents: await applyCommonJsSemantics(bundler, args.path, source),
        loader: 'js',
        resolveDir: dirname(args.path),
      };
    });
  },
};

const packageTypeCache = new Map<string, 'module' | 'commonjs'>();

async function isCommonJsModule(filePath: string, source: string): Promise<boolean> {
  const extension = extname(filePath);
  if (extension === '.mjs') return false;
  if (extension === '.cjs') return true;
  if (hasEsmSyntax(source)) return false;
  return (await nearestPackageType(filePath)) === 'commonjs';
}

function hasEsmSyntax(source: string): boolean {
  return (
    /^[ \t]*import[\s{*'"]/mu.test(source) ||
    /^[ \t]*export[\s{*]/mu.test(source) ||
    /\bimport\.meta\b/u.test(source)
  );
}

async function nearestPackageType(filePath: string): Promise<'module' | 'commonjs'> {
  let directory = dirname(filePath);
  for (;;) {
    const cached = packageTypeCache.get(directory);
    if (cached) return cached;
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
        type?: string;
      };
      const type = manifest.type === 'module' ? 'module' : 'commonjs';
      packageTypeCache.set(directory, type);
      return type;
    } catch {
      const parent = dirname(directory);
      if (parent === directory) return 'commonjs';
      directory = parent;
    }
  }
}

async function applyCommonJsSemantics(
  bundler: PluginBuild,
  filePath: string,
  source: string,
): Promise<string> {
  let contents = await resolveRequireCalls(bundler, filePath, source);
  if (
    /\b__dirname\b|\b__filename\b/u.test(contents) &&
    !/\b(?:const|let|var)\s+__(?:dirname|filename)\b/u.test(contents)
  ) {
    contents = [
      `const __filename = ${JSON.stringify(filePath)};`,
      `const __dirname = ${JSON.stringify(dirname(filePath))};`,
      contents,
    ].join('\n');
  }
  return contents;
}

async function resolveRequireCalls(
  bundler: PluginBuild,
  filePath: string,
  source: string,
): Promise<string> {
  const pattern = /\brequire\.resolve\(\s*(['"])([^'"]+)\1\s*\)/gu;
  const matches = [...source.matchAll(pattern)];
  if (!matches.length) return source;
  const replacements: { start: number; end: number; value: string }[] = [];
  for (const match of matches) {
    const specifier = match[2]!;
    const resolved = await bundler.resolve(specifier, {
      kind: 'require-resolve',
      resolveDir: dirname(filePath),
    });
    if (resolved.errors.length) continue;
    replacements.push({
      start: match.index!,
      end: match.index! + match[0].length,
      value: JSON.stringify(resolved.path),
    });
  }
  if (!replacements.length) return source;
  let result = '';
  let cursor = 0;
  for (const replacement of replacements) {
    result += source.slice(cursor, replacement.start) + replacement.value;
    cursor = replacement.end;
  }
  return result + source.slice(cursor);
}

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
  ...(options.target !== 'browser' && options.format !== 'cjs' && options.nodeRuntime
    ? { banner: nodeEsmBanner }
    : {}),
  ...(options.target !== 'browser' ? { plugins: [nodeCommonJsSemantics] } : {}),
  // Workspace packages import their upstream Cordis typings with a value import
  // that keeps the module load. The vendored packages declare no side effects,
  // so esbuild reports the dropped import for every plugin entry.
  logOverride: { 'ignored-bare-import': 'silent' },
});
