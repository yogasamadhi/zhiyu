import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';

const releaseRoot = resolve(import.meta.dirname, '../dist/headless/linux-x64');
const launcher = resolve(releaseRoot, 'zhiyun-api');
const worker = resolve(releaseRoot, 'analytics-worker/linux-x64/analytics-worker/analytics-worker');
await Promise.all([access(launcher, constants.X_OK), access(worker, constants.X_OK)]);
await Promise.all([
  access(resolve(releaseRoot, 'compliance/node.json')),
  access(resolve(releaseRoot, 'compliance/python.json')),
  access(resolve(releaseRoot, 'web/index.html')),
]);
const [launcherStat, workerStat, checksums] = await Promise.all([
  stat(launcher),
  stat(worker),
  readFile(resolve(releaseRoot, 'SHA256SUMS'), 'utf8'),
]);
if (launcherStat.size < 10 * 1024 * 1024)
  throw new Error('Headless launcher is unexpectedly small');
if (workerStat.size < 1024 * 1024) throw new Error('Analytics Worker is unexpectedly small');
if (
  !checksums.includes('zhiyun-api') ||
  !checksums.includes('analytics-worker') ||
  !checksums.includes('web/index.html')
) {
  throw new Error('Packaged checksums are incomplete');
}
console.log(
  JSON.stringify({
    productVersion: '1.0.0',
    platform: 'linux-x64',
    launcherBytes: launcherStat.size,
    workerBytes: workerStat.size,
  }),
);
