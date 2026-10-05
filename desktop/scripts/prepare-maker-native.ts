import { dirname, join } from 'node:path';

if (process.platform === 'darwin') {
  const nodeGyp = Bun.resolveSync('node-gyp/bin/node-gyp.js', import.meta.dirname);
  for (const [packageName, outputName] of [
    ['macos-alias', 'volume.node'],
    ['fs-xattr', 'xattr.node'],
  ] as const) {
    const packageFile = Bun.resolveSync(`${packageName}/package.json`, import.meta.dirname);
    const result = Bun.spawnSync({
      cmd: ['node', nodeGyp, 'rebuild'],
      cwd: dirname(packageFile),
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Unable to build the ${packageName} host addon required by the DMG maker. A build-time Node.js and Python toolchain are required.`,
      );
    }

    const addon = join(dirname(packageFile), 'build', 'Release', outputName);
    if (!(await Bun.file(addon).exists())) {
      throw new Error(`${packageName} build completed without producing ${outputName}`);
    }
  }
}
