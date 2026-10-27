import { mkdir, readFile, writeFile, cp, symlink, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { build as esbuild, type BuildOptions } from 'esbuild';
import { resolveProductGraph } from '@zhiyun/product-profiles';
import runtimeDependencies from './runtime-dependencies.ts';
import { allowedRoute } from '../src/host/policy.js';

const root = resolve(import.meta.dirname, '..');
const repository = resolve(root, '..');
await mkdir(join(root, 'lib'), { recursive: true });
await rm(join(root, 'lib/runtime.cjs'), { force: true });
const graph = resolveProductGraph('dsh-studio');
const catalog = graph.plugins
  .flatMap(({ descriptor }) =>
    (descriptor.routes ?? []).map((route) => ({ ...route, ownerPluginId: descriptor.id })),
  )
  .filter(allowedRoute);
await writeFile(join(root, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
await cp(join(repository, 'desktop/packages/profiles/catalog/config'), join(root, 'lib/profiles'), {
  recursive: true,
});
await cp(join(repository, 'LICENSE'), join(root, 'LICENSE'));
await mkdir(join(root, 'lib/types/shared'), { recursive: true });
await cp(join(root, 'src/shared/protocol.ts'), join(root, 'lib/types/shared/protocol.d.ts'));
await writeFile(join(root, 'lib/types.js'), 'export {};\n');
async function build(options: BuildOptions & { outfile?: string }): Promise<string> {
  const { outfile, ...rest } = options;
  const target = outfile ?? join(root, 'lib/.build-output.js');
  const result = await esbuild({
    conditions: ['development'],
    jsx: 'automatic',
    target: 'es2023',
    bundle: true,
    minify: false,
    logLevel: 'warning',
    metafile: true,
    logOverride: { 'ignored-bare-import': 'silent' },
    outfile: target,
    ...rest,
  });
  if (rest.alias) {
    const providers = Object.keys(result.metafile!.inputs).filter((path) =>
      /react-query\/.*\/QueryClientProvider\.(?:js|cjs)$/.test(path),
    );
    if (providers.length !== 1)
      throw new Error(`Workbench must contain one React Query provider: ${providers.join(', ')}`);
  }
  const output = await readFile(target, 'utf8');
  if (!outfile) await rm(target, { force: true });
  return output;
}
await build({
  entryPoints: [join(root, 'src/runtime/entry.ts')],
  outfile: join(root, 'lib/runtime.mjs'),
  platform: 'node',
  format: 'esm',
  banner: {
    js: 'import {createRequire as zhCreateRequire} from "node:module"; import {fileURLToPath as zhFileURLToPath} from "node:url"; import {dirname as zhDirname} from "node:path"; const ZH_PLUGIN_URL=import.meta.url; const ZH_PLUGIN_DIR=zhDirname(zhFileURLToPath(ZH_PLUGIN_URL)); const require=zhCreateRequire(ZH_PLUGIN_URL);',
  },
  define: { 'import.meta.dirname': 'ZH_PLUGIN_DIR', 'import.meta.url': 'ZH_PLUGIN_URL' },
  external: Object.keys(runtimeDependencies),
});
await build({
  entryPoints: [join(root, 'src/host/index.ts')],
  outfile: join(root, 'lib/index.js'),
  platform: 'node',
  format: 'esm',
  external: ['@deepseek-ai/*', 'zod'],
});
const workbenchCode = await build({
  entryPoints: [join(root, 'src/workbench/index.tsx')],
  platform: 'browser',
  format: 'cjs',
  // pnpm peer contexts must share the workbench's context providers.
  alias: Object.fromEntries(
    ['@tanstack/react-query', 'react-router-dom', 'react-i18next'].map((name) => [
      name,
      join(root, 'node_modules', name),
    ]),
  ),
  external: [
    'react',
    'react-dom',
    'react/jsx-runtime',
    'react/jsx-dev-runtime',
    '@deepseek-ai/cordis',
  ],
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.env.DEV': 'false',
    'import.meta.env.PROD': 'true',
    'import.meta.env.VITE_FIXTURE_URL': 'undefined',
  },
  plugins: [
    {
      name: 'dsh-compatible-ui',
      setup(builder) {
        builder.onLoad({ filter: /ui-sdk\/src\/i18n\.ts$/ }, async ({ path }) => ({
          loader: 'ts',
          contents: (await readFile(path, 'utf8'))
            .replace('await i18n.use(', 'void i18n.use(')
            .replace('.init({', '.init({ initImmediate: false,'),
        }));
        builder.onLoad(
          {
            filter:
              /plugins\/(?:collection|outputs)\/src\/client\/pages\/(?:TaskEditorPage|OutputsPage)\.tsx$/,
          },
          async ({ path }) => {
            let contents = await readFile(path, 'utf8');
            const nativeCheck = "typeof window !== 'undefined' && Boolean(window.zhiyunRuntime)";
            if (!contents.includes(nativeCheck))
              throw new Error('Hosted credential UI adapter needs updating');
            contents = contents.replace(nativeCheck, 'true');
            if (path.endsWith('/OutputsPage.tsx'))
              contents = contents
                .replace('runtimeClient.listApiTokens()', 'Promise.resolve([])')
                .replace("          ['api', productCopy('API 访问'), 'API access'],\n", '')
                .replace("{section === 'api' && (", '{false && (')
                .replace('、通知和 API 访问', '和通知')
                .replace('notifications and API access', 'notifications');
            return { loader: 'tsx', contents };
          },
        );
        builder.onLoad({ filter: /\.css$/ }, () => ({
          loader: 'js',
          contents: 'export default ""',
        }));
      },
    },
  ],
});
await import('./styles.ts');
// The official generator discovers packages below a workspace's packages/ directory.
// Keep its compiler-only project isolated from both desktop and DSH Context merges.
const project = join(root, '.test/generator');
const pkg = join(project, 'packages/plugin');
const protocol = join(project, 'packages/protocol');
await mkdir(pkg, { recursive: true });
await rm(join(pkg, 'src'), { recursive: true, force: true });
await rm(join(protocol, 'src'), { recursive: true, force: true });
await mkdir(protocol, { recursive: true });
await mkdir(join(protocol, 'src'), { recursive: true });
// The public generator currently recognizes markers only from registered source packages.
// Its compiler-only marker face avoids traversing unrelated Host implementation types.
await writeFile(
  join(protocol, 'src/index.ts'),
  'import type { Context } from "@deepseek-ai/cordis";\nexport declare function Remote(...args: unknown[]): any;\nexport declare class TypertRemoteService { constructor(ctx: Context, key: string); }\n',
);
await writeFile(
  join(protocol, 'package.json'),
  JSON.stringify({
    name: '@deepseek-ai/dsh-typert-protocol',
    type: 'module',
    exports: { '.': { types: './lib/types/index.d.ts', default: './lib/index.js' } },
  }),
);
await writeFile(
  join(protocol, 'tsconfig.json'),
  JSON.stringify({ extends: join(root, 'tsconfig.json'), include: ['src/**/*.ts'] }),
);
await cp(join(root, 'src/shared'), join(pkg, 'src/shared'), { recursive: true });
await cp(join(root, 'catalog.json'), join(pkg, 'catalog.json'));
const hostSource = await readFile(join(root, 'src/host/index.ts'), 'utf8');
const parsed = ts.createSourceFile('index.ts', hostSource, ts.ScriptTarget.Latest, true);
const service = parsed.statements.find(
  (statement) => ts.isClassDeclaration(statement) && statement.name?.text === 'ZhiYunService',
) as ts.ClassDeclaration;
const methods = service.members
  .filter(
    (member) =>
      ts.isMethodDeclaration(member) &&
      ts.getDecorators(member)?.some((decorator) => decorator.getText().startsWith('@Remote')),
  )
  .map((member) => {
    const method = member as ts.MethodDeclaration;
    return (
      hostSource.slice(method.getFullStart(), method.body!.getStart()) +
      '{ throw new Error("metadata-only declaration"); }'
    );
  });
await writeFile(
  join(pkg, 'src/index.ts'),
  'import type { Context } from "@deepseek-ai/cordis";\nimport { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";\nimport type { ApiResult, EventFrame, InvokeInput, Json, ModelSelection, RuntimeReady, RuntimeStatus } from "./shared/protocol.js";\nexport type * from "./shared/protocol.js";\ndeclare module "@deepseek-ai/cordis" {interface Context {zhiyun: ZhiYunService}}\nexport class ZhiYunService extends TypertRemoteService { constructor(ctx:Context){super(ctx,"zhiyun")}\n' +
    methods.join('\n') +
    '\n}\n',
);
await writeFile(join(pkg, 'package.json'), await readFile(join(root, 'package.json')));
await writeFile(
  join(pkg, 'tsconfig.json'),
  JSON.stringify({
    extends: join(root, 'tsconfig.json'),
    compilerOptions: {
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      outDir: 'lib/types',
      rootDir: 'src',
      paths: { '@deepseek-ai/dsh-typert-protocol': [join(protocol, 'src/index.ts')] },
    },
    include: ['src/**/*.ts'],
  }),
);
await writeFile(
  join(project, 'tsconfig.host.json'),
  JSON.stringify({
    extends: join(root, 'tsconfig.json'),
    compilerOptions: {
      paths: { '@deepseek-ai/dsh-typert-protocol': [join(protocol, 'src/index.ts')] },
    },
    files: [],
    include: [],
    references: [{ path: './packages/plugin' }, { path: './packages/protocol' }],
  }),
);
if (!existsSync(join(project, 'node_modules')))
  await symlink(join(root, 'node_modules'), join(project, 'node_modules'), 'dir');
const { WorkspaceTypertGenerator, writeWorkspaceArtifacts } =
  await import('@deepseek-ai/dsh-typert-generator');
const generator = new WorkspaceTypertGenerator(project, { checkDiagnostics: false });
const artifacts = generator.generate(['dsh-zhiyun'], ['host']);
if (!artifacts.length) throw new Error('Typert did not discover the plugin');
writeWorkspaceArtifacts(project, artifacts);
for (const file of [
  'typert.host.js',
  'typert.host.d.ts',
  'typert.remote-client.js',
  'typert.remote-client.d.ts',
])
  await cp(join(pkg, 'lib', file), join(root, 'lib', file));
const clientCode = await build({
  entryPoints: [join(root, 'src/client/index.tsx')],
  platform: 'browser',
  format: 'cjs',
  external: ['react', 'react/jsx-runtime', '@zhiyun/dsh-workbench'],
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    {
      name: 'workbench-styles',
      setup(builder) {
        builder.onLoad({ filter: /client\/styles\.ts$/ }, async () => ({
          loader: 'js',
          contents: `export default ${JSON.stringify(await readFile(join(root, 'lib/workbench.css'), 'utf8'))}`,
        }));
      },
    },
  ],
});
await writeFile(
  join(root, 'lib/client.js'),
  `window.__ModuleLoader__.load({id:"dsh-zhiyun",factory(require){try{\nconst workbench=(()=>{const module={exports:{}};const exports=module.exports;\n${workbenchCode}\nreturn module.exports;})();\nconst shared=require; require=(id)=>id==="@zhiyun/dsh-workbench"?workbench:shared(id);\nconst module={exports:{}};const exports=module.exports;\n${clientCode}\nreturn module.exports;\n}catch(error){console.error("ZhiYun client factory:",error);throw error} }});\n`,
);

for (const file of ['index.js', 'runtime.mjs'])
  execFileSync(process.execPath, ['--check', join(root, 'lib', file)], { stdio: 'inherit' });
console.log(`Built dsh-zhiyun: ${catalog.length} business operations`);
