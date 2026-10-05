import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir, platform, arch, cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { testEnvironment } from '../../../tooling/scripts/test-environment.js';

const [directoryArg, mode = 'baseline', instrumentation] = process.argv.slice(2);
if (
  !directoryArg ||
  !['baseline', 'stream', 'pipeline'].includes(mode) ||
  (instrumentation !== undefined && instrumentation !== 'profile') ||
  (mode === 'pipeline' && instrumentation !== undefined)
)
  throw new Error(
    'Usage: bun --no-env-file collection-resource.ts <run-artifact-directory> baseline|stream [profile], or pipeline',
  );
const profiling = instrumentation === 'profile';
const label = `${mode}${profiling ? '-profile' : ''}`;
const directory = resolve(directoryArg);
const baseline = join(directory, 'opt04-baseline');
const resultsDirectory = join(directory, 'opt04-performance');
await mkdir(resultsDirectory, { recursive: true });
const manifest = JSON.parse(await readFile(join(baseline, 'manifest.json'), 'utf8')) as {
  sourceHashes: Record<string, string>;
};
for (const [name, hash] of Object.entries(manifest.sourceHashes))
  if (
    createHash('sha256')
      .update(await readFile(join(baseline, name)))
      .digest('hex') !== hash
  )
    throw new Error(`Saved baseline changed: ${name}`);
for (const name of ['shared', 'extraction', 'browser-runtime', 'crawler-runtime']) {
  const packageRoot =
    mode === 'baseline' ? join(baseline, name) : resolve('desktop/packages', name);
  const built = await Bun.build({
    entrypoints: [join(packageRoot, 'src/index.ts')],
    outdir: join(packageRoot, 'dist'),
    target: 'node',
    format: 'esm',
    packages: 'external',
  });
  if (!built.success)
    throw new Error(`Unable to compile baseline ${name}: ${built.logs.map(String).join('\n')}`);
}
const worker = join(resultsDirectory, 'worker.mjs');
const built = await Bun.build({
  entrypoints: [resolve(import.meta.dirname, 'collection-resource-worker.ts')],
  outdir: resultsDirectory,
  naming: 'worker.mjs',
  target: 'node',
  format: 'esm',
  packages: 'external',
});
if (!built.success) throw new Error('Unable to compile benchmark worker');
let total = 0;
let actualRequests = 0;
async function serveFixture(request: IncomingMessage, response: ServerResponse) {
  try {
    const page = Number(new URL(request.url ?? '/', 'http://fixture').searchParams.get('page'));
    if (!Number.isSafeInteger(page) || page < 1) {
      response.writeHead(400).end();
      return;
    }
    actualRequests += 1;
    response.setHeader('content-type', 'application/json');
    response.write('{"items":[');
    for (let index = (page - 1) * 1000; index < Math.min(total, page * 1000); index++) {
      const record = { id: String(index).padStart(8, '0'), name: 'Fixture', payload: '' };
      record.payload = 'x'.repeat(1024 - Buffer.byteLength(JSON.stringify(record)));
      if (!response.write(`${index === (page - 1) * 1000 ? '' : ','}${JSON.stringify(record)}`))
        await once(response, 'drain');
    }
    response.end(']}');
  } catch {
    response.destroy();
  }
}
const server = createServer((request, response) => {
  void serveFixture(request, response);
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
const origin = `http://127.0.0.1:${address.port}`;
const measurements: Record<string, number | string>[] = [];
let liveChild: ReturnType<typeof Bun.spawn> | undefined;
const interrupt = () => {
  liveChild?.kill('SIGTERM');
  server.closeAllConnections();
};
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
try {
  for (const count of profiling ? [100000] : [10000, 100000])
    for (let iteration = 1; iteration <= (profiling ? 1 : 3); iteration++) {
      total = count;
      actualRequests = 0;
      const storage = await mkdtemp(join(tmpdir(), 'zhiyun-collection-benchmark-'));
      let externalPeak = 0;
      let started = false;
      let report: Record<string, number | string> | undefined;
      let log = '';
      const packageRoot = mode === 'baseline' ? baseline : resolve('desktop/packages');
      const entry = join(packageRoot, 'crawler-runtime/dist/index.js');
      const sharedEntry = join(packageRoot, 'shared/dist/index.js');
      const command =
        mode === 'pipeline'
          ? [
              'node',
              '--expose-gc',
              '--experimental-transform-types',
              '--conditions=development',
              '--import',
              resolve('desktop/packages/plugins/collection/test/fixtures/recovery-loader.mjs'),
              resolve(import.meta.dirname, 'collection-pipeline-worker.ts'),
              origin,
              String(count),
              storage,
            ]
          : [
              'node',
              '--expose-gc',
              worker,
              entry,
              sharedEntry,
              origin,
              String(count),
              mode,
              ...(profiling
                ? [join(resultsDirectory, `${label}-${count}-${iteration}.cpuprofile`)]
                : []),
            ];
      const child = Bun.spawn(command, {
        env: { ...testEnvironment(process.env), CRAWLEE_STORAGE_DIR: storage },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      liveChild = child;
      const timer = setInterval(() => {
        if (!started) return;
        const sample = Bun.spawnSync(['ps', '-p', String(child.pid), '-o', 'rss=']);
        if (sample.exitCode === 0)
          externalPeak = Math.max(externalPeak, Number(sample.stdout.toString().trim()) * 1024);
      }, 25);
      const stderr = new Response(child.stderr).text();
      try {
        let pending = '';
        for await (const chunk of child.stdout) {
          const value = new TextDecoder().decode(chunk);
          log += value;
          pending += value;
          let split: number;
          while ((split = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, split);
            pending = pending.slice(split + 1);
            if (!line.startsWith('ZHIYUN_BENCH ')) continue;
            const message = JSON.parse(line.slice('ZHIYUN_BENCH '.length));
            if (message.ready) {
              started = true;
              externalPeak = message.initialRssBytes;
              await child.stdin.write('start\n');
            }
            if (message.measured) started = false;
            if (message.complete) report = message;
          }
        }
        const code = await child.exited;
        log += await stderr;
        await writeFile(join(resultsDirectory, `${label}-${count}-${iteration}.txt`), log);
        if (code !== 0 || !report)
          throw new Error(
            `Benchmark failed: ${mode}/${count}/${iteration}, exit ${code}. See per-run log.`,
          );
        if (actualRequests !== Number(report.requestCount))
          throw new Error('Fixture and Runtime request counts differ');
        const peak = Math.max(
          externalPeak,
          Number(report.sampledPeakRssBytes),
          Number(report.resourcePeakRssBytes),
        );
        const result = {
          ...report,
          measurementKind: profiling ? 'cpu-profile-diagnostic' : 'resource-benchmark',
          iteration,
          externalPeakRssBytes: externalPeak,
          peakRssBytes: peak,
          incrementalPeakRssBytes: Math.max(0, peak - Number(report.initialRssBytes)),
          actualRequests,
        };
        measurements.push(result);
        await writeFile(
          join(resultsDirectory, `${label}.json`),
          JSON.stringify(
            {
              capturedAt: new Date().toISOString(),
              measurementKind: profiling ? 'cpu-profile-diagnostic' : 'resource-benchmark',
              scope:
                mode === 'pipeline'
                  ? 'Current production Collection handler, Artifact, SQLite raw spool, staging and Dataset/Snapshot projection. No Electron host, queue dispatch, browser, Python or Parquet materialization. No saved original full-pipeline throughput baseline.'
                  : 'HTTP JSON pagination Runtime with a counting consumer. No production Artifact/SQLite I/O, UI, browser or Python.',
              hardware: {
                platform: platform(),
                arch: arch(),
                cpu: cpus()[0]?.model,
                logicalCpus: cpus().length,
                totalMemoryBytes: totalmem(),
              },
              sampling:
                'Parent ps RSS every 25 ms after ready, Runtime RSS every 20 ms and progress/batch boundaries, Node maxRSS; peak is maximum of all three. Baseline RSS after imports and one initial GC; no forced GC during collection. Parent fixture creates one exact 1024-byte JSON row at a time, honors response backpressure, and is excluded from Runtime RSS. Each measurement starts a fresh Node process.',
              measurements,
            },
            null,
            2,
          ) + '\n',
        );
        console.log(
          `${label} ${count} #${iteration}: ${(Number(report.elapsedMs) / 1000).toFixed(2)}s, +${(result.incrementalPeakRssBytes / 1024 / 1024).toFixed(1)} MiB RSS, ${Number(report.recordsPerSecond).toFixed(0)} rows/s`,
        );
      } finally {
        clearInterval(timer);
        try {
          await child.stdin.end();
        } catch {
          // The worker may already have closed its input; still clean its resources.
        }
        if (child.exitCode === null) {
          child.kill('SIGTERM');
          await child.exited;
        }
        liveChild = undefined;
        await rm(storage, { recursive: true, force: true });
      }
    }
} finally {
  interrupt();
  await new Promise<void>((done) => server.close(() => done()));
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}
