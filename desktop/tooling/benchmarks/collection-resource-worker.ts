import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { Session } from 'node:inspector/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [entry, sharedEntry, origin, countText, mode, profilePath] = process.argv.slice(2);
if (!entry || !sharedEntry || !origin || !countText || !['baseline', 'stream'].includes(mode ?? ''))
  throw new Error('Invalid benchmark worker arguments');
const total = Number(countText);
const { CrawlerRuntime } = await import(pathToFileURL(resolve(entry)).href);
const { normalizeCrawlPlan, requestSettingsSchema } = await import(
  pathToFileURL(resolve(sharedEntry)).href
);
const pageSize = 1000;
const pages = Math.ceil(total / pageSize);
(globalThis as { gc?: () => void }).gc?.();
const initialRssBytes = process.memoryUsage().rss;
const initialPeakRssBytes = process.resourceUsage().maxRSS * 1024;
process.stdout.write(
  `ZHIYUN_BENCH ${JSON.stringify({ ready: true, initialRssBytes, initialPeakRssBytes })}\n`,
);
await once(process.stdin, 'data');
process.stdin.pause();
let sampledPeak = initialRssBytes;
const sample = () => {
  sampledPeak = Math.max(sampledPeak, process.memoryUsage().rss);
};
const timer = setInterval(sample, 20);
const profiler = profilePath ? new Session() : undefined;
if (profiler) {
  profiler.connect();
  await profiler.post('Profiler.enable');
  await profiler.post('Profiler.start');
}
const started = performance.now();
let streamedCount = 0;
let maxBatchRows = 0;
try {
  const result = await new CrawlerRuntime().crawl({
    url: `${origin}/records?page=1`,
    plan: normalizeCrawlPlan({
      list: {
        mode: 'http',
        rule: {
          type: 'json',
          container: '$.items[*]',
          fields: {
            id: { path: '$.id', dataType: 'string' },
            name: { path: '$.name', dataType: 'string' },
            payload: { path: '$.payload', dataType: 'string' },
          },
        },
      },
      pagination: {
        type: 'page',
        urlTemplate: `${origin}/records?page={page}`,
        startPage: 1,
        maxPages: pages,
      },
      dedupe: { strategy: 'none', fields: [] },
      limits: { maxRecords: total },
    }),
    requestSettings: requestSettingsSchema.parse({
      retries: 0,
      delayMs: 0,
      respectRobotsTxt: false,
      concurrency: 1,
      domainRateLimitPerMinute: 10000,
      maxRequests: pages,
      maxRuntimeMs: 300000,
    }),
    browserSettings: { enabled: false, waitUntil: 'domcontentloaded', actions: [] },
    pagination: { type: 'none' },
    networkPolicy: { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
    onProgress: sample,
    ...(mode === 'stream'
      ? {
          onBatch: async (batch: { records: unknown[] }) => {
            streamedCount += batch.records.length;
            maxBatchRows = Math.max(maxBatchRows, batch.records.length);
            sample();
            return { acceptedCount: batch.records.length, totalCount: streamedCount };
          },
        }
      : {}),
  });
  sample();
  const elapsedMs = performance.now() - started;
  if (profiler && profilePath) {
    const { profile } = await profiler.post('Profiler.stop');
    await writeFile(profilePath, JSON.stringify(profile));
  }
  const observedCount = mode === 'stream' ? streamedCount : result.records.length;
  if (mode === 'stream' && result.records.length)
    throw new Error('Streaming benchmark returned an aggregate result');
  if (observedCount !== total || result.metadata.recordCount !== total)
    throw new Error(
      `Record count mismatch: ${observedCount}/${result.metadata.recordCount}/${total}`,
    );
  if (result.metadata.browserUsed) throw new Error('HTTP benchmark unexpectedly used a browser');
  process.stdout.write(
    `ZHIYUN_BENCH ${JSON.stringify({ complete: true, mode, total, pageSize, recordBytes: 1024, initialRssBytes, initialPeakRssBytes, sampledPeakRssBytes: sampledPeak, resourcePeakRssBytes: process.resourceUsage().maxRSS * 1024, elapsedMs, recordsPerSecond: total / (elapsedMs / 1000), requestCount: result.metadata.requestCount, browserRequests: 0, pythonProcesses: 0, maxBatchRows, runtime: process.version, cwd: dirname(entry) })}\n`,
  );
} finally {
  clearInterval(timer);
  profiler?.disconnect();
}
