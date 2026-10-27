import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

if (process.platform === 'darwin') {
  const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js');
  for (const [packageName, outputName] of [
    ['macos-alias', 'volume.node'],
    ['fs-xattr', 'xattr.node'],
  ] as const) {
    const packageFile = require.resolve(`${packageName}/package.json`);
    const result = spawnSync('node', [nodeGyp, 'rebuild'], {
      cwd: dirname(packageFile),
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      throw new Error(
        `Unable to build the ${packageName} host addon required by the DMG maker. A build-time Node.js and Python toolchain are required.`,
      );
    }

    const addon = join(dirname(packageFile), 'build', 'Release', outputName);
    if (!existsSync(addon)) {
      throw new Error(`${packageName} build completed without producing ${outputName}`);
    }
  }
}
