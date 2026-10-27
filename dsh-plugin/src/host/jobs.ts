import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-jobs';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { ApiResult, InvokeInput, Json, ModelSelection } from '../shared/protocol.js';
import type { ZhiYunService } from './index.js';
declare module '@deepseek-ai/dsh-jobs/view' {
  interface JobKindMap {
    zhiyun: 'zhiyun';
  }
}
const kinds: Record<string, { field: string; get: string; cancel: string; key: string }> = {
  createRun: { field: 'runId', get: 'getRun', cancel: 'cancelRun', key: 'runId' },
  createAnalysisJob: {
    field: 'job',
    get: 'getAnalysisJob',
    cancel: 'cancelAnalysisJob',
    key: 'jobId',
  },
  retryAnalysisJob: {
    field: 'job',
    get: 'getAnalysisJob',
    cancel: 'cancelAnalysisJob',
    key: 'jobId',
  },
  createCorpusBuild: {
    field: 'build',
    get: 'getCorpusBuild',
    cancel: 'cancelCorpusBuild',
    key: 'buildId',
  },
  retryCorpusBuild: {
    field: 'build',
    get: 'getCorpusBuild',
    cancel: 'cancelCorpusBuild',
    key: 'buildId',
  },
};
/** Session-local controls mirror durable business jobs; the business queue remains authoritative. */
export function mirrorJob(
  ctx: Context,
  service: ZhiYunService,
  input: InvokeInput,
  result: ApiResult,
  exec: ToolExecution,
  model: ModelSelection | null,
): string | undefined {
  const kind = kinds[input.operationId];
  if (!kind || result.status >= 300 || !exec.agent) return;
  const body = result.body as Record<string, Json>;
  const item = body[kind.field] ?? body;
  const id = typeof item === 'string' ? item : (item as Record<string, Json>)?.id;
  if (typeof id !== 'string') return;
  return ctx.jobs.start({
    kind: 'zhiyun',
    owner: exec.agent.id,
    label: `ZhiYun ${input.operationId} ${id}`,
    run(handle) {
      let canceled = false;
      const controller = new AbortController();
      const done = (async () => {
        try {
          while (true) {
            const current = await service.invokeFor(
              { workspaceId: input.workspaceId, operationId: kind.get, path: { [kind.key]: id } },
              model,
              controller.signal,
            );
            if (current.status >= 400) throw new Error('Durable job unavailable');
            const object = current.body as Record<string, Json>;
            const state = (object[kind.field] ?? object) as Record<string, Json>;
            const status = String(state.status ?? state.state);
            handle.updateProgress(`${id}: ${status}`);
            if (['succeeded', 'completed', 'failed', 'canceled', 'cancelled'].includes(status))
              return {
                status:
                  status === 'failed'
                    ? ('failed' as const)
                    : canceled || status.startsWith('cancel')
                      ? ('killed' as const)
                      : ('completed' as const),
                result: JSON.stringify(current.body),
              };
            await delay(750, undefined, { signal: controller.signal });
          }
        } catch {
          return {
            status: canceled ? ('killed' as const) : ('failed' as const),
            detail: `Inspect durable job ${id} in ZhiYun`,
          };
        }
      })();
      return {
        done,
        cancel() {
          if (canceled) return;
          canceled = true;
          void service
            .invokeFor(
              {
                workspaceId: input.workspaceId,
                operationId: kind.cancel,
                path: { [kind.key]: id },
              },
              model,
              AbortSignal.timeout(15_000),
            )
            .finally(() => controller.abort())
            .catch(() => {});
        },
      };
    },
  });
}
