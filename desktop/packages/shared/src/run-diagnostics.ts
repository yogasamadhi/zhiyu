import { z } from 'zod';
import type { CrawlRun, RunLogEntry } from './index.js';

export const diagnosticErrorCodeSchema = z.enum([
  'NAVIGATION_ERROR',
  'ACTION_STATE_INVALID',
  'SELECTOR_UNMATCHED',
  'EMPTY_PREVIEW',
  'TIMEOUT',
  'RESOURCE_LIMIT',
  'CANCELED',
  'NETWORK_POLICY_ERROR',
  'EXTRACTION_ERROR',
  'WRITE_ERROR',
  'UNEXPECTED_ERROR',
]);
export const diagnosticStepSchema = z.object({
  kind: z.enum(['navigation', 'action', 'selector', 'extraction', 'write']),
  target: z.enum(['list', 'pagination', 'detail', 'dataset']),
  status: z.enum(['succeeded', 'failed', 'skipped', 'canceled']),
  startedAt: z.string().max(40).datetime(),
  durationMs: z.number().int().min(0).max(86_400_000),
  actionType: z
    .enum(['click', 'fill', 'select', 'press', 'hover', 'wait', 'waitFor', 'scroll'])
    .optional(),
  fieldIndex: z.number().int().min(0).max(10_000).optional(),
  matchedCount: z.number().int().min(0).max(10_000_000).optional(),
  recordCount: z.number().int().min(0).max(10_000_000).optional(),
  writtenCount: z.number().int().min(0).max(10_000_000).optional(),
  writePhase: z.enum(['staging', 'projection']).optional(),
  statusCode: z.number().int().min(100).max(599).optional(),
  errorCode: diagnosticErrorCodeSchema.optional(),
});
export type DiagnosticStep = z.infer<typeof diagnosticStepSchema>;
export type DiagnosticErrorCode = z.infer<typeof diagnosticErrorCodeSchema>;
export type DiagnosticObserver = (step: DiagnosticStep) => void | Promise<void>;
export const runDiagnosticsSchema = z.object({
  formatVersion: z.literal(1),
  run: z.object({
    id: z.string().uuid(),
    taskId: z.string().uuid(),
    traceId: z.string().uuid(),
    ruleVersionId: z.string().uuid().nullable(),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled']),
    startedAt: z.string().max(40).datetime().nullable(),
    finishedAt: z.string().max(40).datetime().nullable(),
    errorCode: diagnosticErrorCodeSchema.nullable(),
  }),
  available: z.boolean(),
  truncated: z.boolean(),
  stepCount: z.number().int().nonnegative(),
  steps: z.array(diagnosticStepSchema).max(256),
});

export function classifyDiagnosticError(error: unknown, signal?: AbortSignal): DiagnosticErrorCode {
  if (signal?.aborted)
    return signal.reason === 'Crawl exceeded maxRuntime' ? 'RESOURCE_LIMIT' : 'CANCELED';
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = diagnosticErrorCodeSchema.safeParse('code' in current ? current.code : null);
    if (current.name === 'TimeoutError' || /timeout|timed out/i.test(current.message))
      return 'TIMEOUT';
    if (/exceed|resource.limit|maxRuntime/i.test(current.message)) return 'RESOURCE_LIMIT';
    if (code.success && code.data !== 'NAVIGATION_ERROR') return code.data;
    current = current.cause ?? ('details' in current ? current.details : undefined);
  }
  const code = diagnosticErrorCodeSchema.safeParse(
    error instanceof Error && 'code' in error ? error.code : null,
  );
  return code.success ? code.data : 'UNEXPECTED_ERROR';
}

/** Observability is best effort and cannot change the underlying operation's result. */
const unavailableObservers = new WeakSet<DiagnosticObserver>();
export async function emitDiagnosticStep(
  observer: DiagnosticObserver | undefined,
  value: unknown,
): Promise<void> {
  if (!observer || unavailableObservers.has(observer)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const step = sanitizeDiagnosticStep(value);
    if (step)
      await Promise.race([
        Promise.resolve().then(() => observer(step)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Diagnostic sink deadline')), 200);
        }),
      ]);
  } catch {
    // A diagnostic sink can be unavailable while collection remains usable.
    unavailableObservers.add(observer);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function observeDiagnosticOperation<T>(
  observer: DiagnosticObserver | undefined,
  identity: Pick<DiagnosticStep, 'kind' | 'target' | 'actionType' | 'fieldIndex' | 'writePhase'>,
  operation: () => T | Promise<T>,
  summarize?: (result: T) => Partial<DiagnosticStep>,
  signal?: AbortSignal,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await operation();
    let counts: Partial<DiagnosticStep> = {};
    try {
      counts = summarize?.(result) ?? {};
    } catch {
      /* Metadata is best effort too. */
    }
    await emitDiagnosticStep(observer, {
      ...identity,
      ...counts,
      status: counts.status ?? 'succeeded',
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
    });
    return result;
  } catch (error) {
    const classified = classifyDiagnosticError(error, signal);
    const code =
      identity.kind === 'selector' && classified === 'TIMEOUT'
        ? 'SELECTOR_UNMATCHED'
        : classified === 'UNEXPECTED_ERROR'
          ? identity.kind === 'write'
            ? 'WRITE_ERROR'
            : identity.kind === 'extraction'
              ? 'EXTRACTION_ERROR'
              : identity.kind === 'navigation'
                ? 'NAVIGATION_ERROR'
                : classified
          : classified;
    await emitDiagnosticStep(observer, {
      ...identity,
      status: code === 'CANCELED' ? 'canceled' : 'failed',
      errorCode: code,
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
    });
    throw error;
  }
}

export function diagnosticRecovery(code: DiagnosticErrorCode) {
  if (code === 'CANCELED') return 'new_run' as const;
  if (code === 'RESOURCE_LIMIT' || code === 'TIMEOUT') return 'edit_limits' as const;
  if (
    code === 'SELECTOR_UNMATCHED' ||
    code === 'EMPTY_PREVIEW' ||
    code === 'EXTRACTION_ERROR' ||
    code === 'ACTION_STATE_INVALID'
  )
    return 'edit_fields' as const;
  if (code === 'NETWORK_POLICY_ERROR') return 'edit_access' as const;
  return 'retry' as const;
}

/** Strict allowlist: no free text, selectors, URLs, DOM, screenshots or input values. */
export function sanitizeDiagnosticStep(value: unknown): DiagnosticStep | null {
  try {
    const result = diagnosticStepSchema.safeParse(value);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function buildRunDiagnostics(run: CrawlRun, logs: RunLogEntry[], totalSteps?: number) {
  const identity = z.string().uuid();
  const timestamp = z.string().max(40).datetime().nullable();
  const steps = logs
    .filter((log) => log.runId === run.id)
    .map((log) => sanitizeDiagnosticStep(log.metadata.diagnostic))
    .filter((step): step is DiagnosticStep => step !== null);
  const actualVersion = logs.findLast(
    (log) => log.runId === run.id && identity.safeParse(log.metadata.ruleVersionId).success,
  )?.metadata.ruleVersionId;
  const version = identity.safeParse(actualVersion ?? run.metadata.expectedRuleVersionId);
  const trace = identity.safeParse(run.metadata.traceId);
  const error = diagnosticErrorCodeSchema.safeParse(run.errorCode);
  const lastError = steps.findLast((step) => step.errorCode)?.errorCode;
  const report = {
    formatVersion: 1 as const,
    run: {
      id: identity.parse(run.id),
      taskId: identity.parse(run.taskId),
      traceId: trace.success ? trace.data : identity.parse(run.id),
      ruleVersionId: version.success ? version.data : null,
      status: z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled']).parse(run.status),
      startedAt: timestamp.parse(run.startedAt),
      finishedAt: timestamp.parse(run.finishedAt),
      errorCode: error.success
        ? error.data
        : ['failed', 'canceled'].includes(run.status)
          ? (lastError ?? null)
          : null,
    },
    available: steps.length > 0,
    truncated: (totalSteps ?? steps.length) > 256,
    stepCount: totalSteps ?? steps.length,
    steps: steps.slice(-256),
  };
  const encoder = new TextEncoder();
  while (encoder.encode(JSON.stringify(report)).byteLength > 64 * 1024 && report.steps.length) {
    report.steps.shift();
    report.truncated = true;
  }
  return report;
}

export type RunDiagnostics = ReturnType<typeof buildRunDiagnostics>;
