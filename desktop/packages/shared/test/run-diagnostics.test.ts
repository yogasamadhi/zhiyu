import { describe, expect, it } from 'vitest';
import {
  buildRunDiagnostics,
  diagnosticRecovery,
  sanitizeDiagnosticStep,
  observeDiagnosticOperation,
  type DiagnosticObserver,
  type CrawlRun,
  type RunLogEntry,
} from '../src/index.js';

const id = '8b3745d3-4a5b-4a52-8246-dd4e87d70dc8';
const taskId = '83c393fe-e3a4-4d5d-912c-d424bfd63f13';
const startedAt = '2026-10-03T07:00:00.000Z';
const run = {
  id,
  taskId,
  status: 'failed',
  startedAt,
  finishedAt: startedAt,
  errorCode: 'TIMEOUT',
  error: 'secret-marker',
  metadata: {
    expectedRuleVersionId: taskId,
    traceId: id,
    headers: { authorization: 'secret-marker' },
  },
} as unknown as CrawlRun;
const step = {
  kind: 'action',
  target: 'list',
  status: 'failed',
  startedAt,
  durationMs: 500,
  actionType: 'fill',
  errorCode: 'TIMEOUT',
};
const log = (diagnostic: unknown, runId = id) =>
  ({
    id: taskId,
    runId,
    metadata: { diagnostic },
    message: 'secret-marker',
    url: 'https://fixture.invalid/secret-marker?token=secret-marker',
  }) as unknown as RunLogEntry;
describe('allowlisted run diagnostics', () => {
  it('keeps successful values and the original thrown error when diagnostics reject or stall', async () => {
    const rejected: DiagnosticObserver = async () => {
      throw new Error('sink unavailable');
    };
    const identity = { kind: 'write' as const, target: 'dataset' as const };
    const original = new Error('original-write-failure');
    expect(await observeDiagnosticOperation(rejected, identity, () => 42)).toBe(42);
    await expect(
      observeDiagnosticOperation(rejected, identity, () => {
        throw original;
      }),
    ).rejects.toBe(original);
    let calls = 0;
    const stalled: DiagnosticObserver = () => {
      calls += 1;
      return new Promise<void>(() => {});
    };
    expect(await observeDiagnosticOperation(stalled, identity, () => 42)).toBe(42);
    expect(await observeDiagnosticOperation(stalled, identity, () => 43)).toBe(43);
    expect(calls).toBe(1);
  });
  it('drops sensitive markers from nested headers, raw DOM, screenshots, selectors and fill values', () => {
    const payload = {
      ...step,
      selector: '[value="secret-marker"]',
      fillValue: 'secret-marker',
      headers: { cookie: 'secret-marker', authorization: 'secret-marker' },
      rawDom: '<input value="secret-marker">',
      screenshot: 'secret-marker',
      trace: { nested: { token: 'secret-marker' } },
    };
    const bundle = buildRunDiagnostics(run, [log(payload)]);
    expect(bundle.steps).toEqual([step]);
    expect(bundle.run).toMatchObject({ traceId: id, ruleVersionId: taskId });
    expect(JSON.stringify(bundle)).not.toContain('secret-marker');
    expect(JSON.stringify(bundle)).not.toContain('fixture.invalid');
  });
  it('ignores another run, corrupt metadata and arbitrary error text, and bounds report size', () => {
    expect(sanitizeDiagnosticStep({ ...step, errorCode: 'secret-marker' })).toBeNull();
    expect(sanitizeDiagnosticStep({ ...step, actionType: 'secret-marker' })).toBeNull();
    expect(
      sanitizeDiagnosticStep({ ...step, startedAt: `2026-10-03T07:00:00.${'1'.repeat(10000)}Z` }),
    ).toBeNull();
    const cyclic: Record<string, unknown> = {};
    cyclic.durationMs = cyclic;
    expect(sanitizeDiagnosticStep(cyclic)).toBeNull();
    const missing = buildRunDiagnostics(run, [
      log(step, taskId),
      log(cyclic),
      log({ ...step, durationMs: -1 }),
    ]);
    expect(missing.available).toBe(false);
    const report = buildRunDiagnostics(
      run,
      Array.from({ length: 1000 }, () => log(step)),
    );
    expect(report.steps).toHaveLength(256);
    expect(report.truncated).toBe(true);
    expect(report.stepCount).toBe(1000);
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThan(64 * 1024);
    const full = buildRunDiagnostics(
      run,
      Array.from({ length: 1000 }, () =>
        log({
          ...step,
          matchedCount: 10_000_000,
          recordCount: 10_000_000,
          writtenCount: 10_000_000,
          statusCode: 599,
          durationMs: 86_400_000,
        }),
      ),
    );
    expect(full.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(full))).toBeLessThanOrEqual(64 * 1024);
  });
  it('maps navigation, selector, timeout and cancellation to concrete recovery actions', () => {
    expect(diagnosticRecovery('NAVIGATION_ERROR')).toBe('retry');
    expect(diagnosticRecovery('SELECTOR_UNMATCHED')).toBe('edit_fields');
    expect(diagnosticRecovery('TIMEOUT')).toBe('edit_limits');
    expect(diagnosticRecovery('CANCELED')).toBe('new_run');
    expect(diagnosticRecovery('NETWORK_POLICY_ERROR')).toBe('edit_access');
  });
});
