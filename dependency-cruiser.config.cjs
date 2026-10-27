/* global module, require */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pluginDirectories = require('node:fs')
  .readdirSync('desktop/packages/plugins', { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

module.exports = {
  forbidden: [
    {
      name: 'cloud-browsers-do-not-import-server',
      severity: 'error',
      from: {
        path: '^platform/((portal|admin)/src|packages/cloud-(ui|client|contracts))/',
      },
      to: {
        path: '^(platform/server|desktop/packages/(runtime|plugins|capabilities))/|(^|/)(postgres|drizzle-orm|bun)(/|$)',
      },
    },
    {
      name: 'cloud-server-does-not-execute-desktop-tools',
      severity: 'error',
      from: { path: '^platform/server/src/' },
      to: {
        path: '^(desktop/(src|packages/(runtime|crawler-runtime|browser-runtime|plugins)))/|^electron$',
      },
    },
    ...pluginDirectories.map((plugin) => ({
      name: `no-${plugin}-cross-plugin-implementation-import`,
      severity: 'error',
      comment:
        'Plugins collaborate through stable contracts and services, never implementation imports.',
      // Cross-Plugin test harnesses may compose concrete adapters for conformance and crash tests;
      // production source remains contract-only.
      from: { path: `^desktop/packages/plugins/${plugin}/(?!test/)` },
      to: {
        path: `^desktop/packages/plugins/(?!${plugin}/)`,
        pathNot: '/src/(types\\.ts|manifest\\.ts|policy\\.ts|contracts/)',
      },
    })),
    {
      name: 'renderer-does-not-import-server-implementation',
      severity: 'error',
      from: {
        path: '^(desktop/packages/(ui|ui-sdk)|desktop/src/renderer|desktop/packages/plugins/[^/]+/src/client)/',
      },
      to: {
        path: '^(desktop/packages/(runtime|storage|sqlite-storage|scheduler)|desktop/packages/plugins/.+/src/(domain|application|http|persistence|migrations))/',
      },
    },
    {
      name: 'runtime-does-not-import-electron',
      severity: 'error',
      from: { path: '^desktop/packages/(runtime|plugins|capabilities)/' },
      to: { path: '^electron$' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: '(^|/)(node_modules|dist|out|\\.next|\\.forge-app|resources/playwright)/|^vendor/',
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      conditionNames: ['development', 'node', 'types', 'import', 'default'],
      exportsFields: ['exports'],
    },
  },
};
