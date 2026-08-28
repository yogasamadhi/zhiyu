import { StagehandAdapter } from './index.js';

const fixtureUrl = process.env.FIXTURE_URL ?? 'http://127.0.0.1:45100/dynamic-products';
const adapter = new StagehandAdapter({
  enabled: process.env.STAGEHAND_ENABLED === 'true',
  ...(process.env.AI_MODEL ? { model: process.env.AI_MODEL } : {}),
  ...(process.env.AI_API_KEY ? { apiKey: process.env.AI_API_KEY } : {}),
});

try {
  const result = await adapter.load(fixtureUrl, {
    browser: { enabled: true, waitUntil: 'domcontentloaded', actions: [] },
    request: {
      headers: {},
      cookies: [],
      timeoutMs: 30_000,
      retries: 0,
      retryBackoffMs: 1_000,
      concurrency: 1,
      delayMs: 0,
      maxRequests: 1,
      maxRuntimeMs: 60_000,
      domainRateLimitPerMinute: 60,
      respectRobotsTxt: true,
      maxResponseBytes: 20 * 1024 * 1024,
      redirectLimit: 10,
    },
  });
  console.log(`Loaded ${result.url} (${result.html.length} bytes)`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
