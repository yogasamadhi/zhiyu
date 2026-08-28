/* global module */

module.exports = {
  forbidden: [
    {
      name: 'no-cross-plugin-implementation-import',
      severity: 'error',
      comment:
        'Plugins collaborate through stable contracts and services, never implementation imports.',
      from: { path: '^plugins/' },
      to: { path: '^plugins/' },
    },
    {
      name: 'renderer-does-not-import-server-implementation',
      severity: 'error',
      from: { path: '^(packages/ui|apps/(web|desktop)/src/renderer)/' },
      to: {
        path: '^(packages/(runtime|storage|sqlite-storage|scheduler)|plugins/.+/(domain|application|http|persistence|migrations))/',
      },
    },
    {
      name: 'runtime-does-not-import-electron',
      severity: 'error',
      from: { path: '^(packages/runtime|plugins|capabilities)/' },
      to: { path: '^electron$' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: '(^|/)(node_modules|dist|out|\\.forge-app|resources/playwright)/',
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      conditionNames: ['development', 'bun', 'types', 'import', 'default'],
      exportsFields: ['exports'],
    },
  },
};
