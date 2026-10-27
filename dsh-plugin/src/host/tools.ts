import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Json, InvokeInput, ModelSelection } from '../shared/protocol.js';
import type { ZhiYunService } from './index.js';
import { mirrorJob } from './jobs.js';
import { assertToolInput } from './policy.js';
import catalog from '../../catalog.json';

const groups: Record<string, string[]> = {
  collection: ['collection', 'ai-assistance'],
  datasets: ['datasets'],
  cleaning: ['datasets'],
  analysis: ['analytics'],
  corpus: ['corpus'],
  monitoring: ['monitoring'],
  outputs: ['outputs'],
  templates: ['templates'],
  jobs: ['platform'],
};
export function registerTools(ctx: Context, service: ZhiYunService): void {
  for (const [group, owners] of Object.entries(groups)) {
    const operations = catalog
      .filter(
        (route) => !/(?:Credential|LoginSession|saveArtifactWithHost)/.test(route.operationId),
      )
      .filter(
        (route) =>
          (owners.includes(route.ownerPluginId) &&
            (group !== 'cleaning' || route.path.includes('/cleaning/'))) ||
          (group === 'jobs' &&
            /(?:Run|AnalysisJob|CorpusBuild|CleaningSession)/.test(route.operationId)),
      )
      .map((route) => route.operationId);
    if (!operations.length) continue;
    ctx.tools.register(
      defineTool({
        name: `zhiyun_${group}`,
        description: `ZhiYun local ${group}. Operation ids: ${operations.join(', ')}. Call zhiyun_operation_schema for the original parameter schemas before mutations. Use path for named resource IDs and body for the original business input. Preview generated rules before committing. Returns durable IDs; inspect jobs for long work. Never supply secrets.`,
        parameters: {
          workspaceId: {
            type: 'string',
            required: true,
            description: 'DSH Workspace ID; use zhiyun_workspaces to discover it.',
          },
          operationId: { type: 'string', enum: operations, required: true },
          path: { type: 'object', additionalProperties: true },
          query: { type: 'object', additionalProperties: true },
          body: { type: 'json' },
          headers: {
            type: 'object',
            additionalProperties: true,
            description: 'Only If-Match and Idempotency-Key are permitted.',
          },
        },
        output: {
          schema: { type: 'json' },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args, exec) {
          assertToolInput(args.body);
          const query = { ...args.query } as Record<string, string | number | boolean>;
          if ('limit' in query) query.limit = Math.min(20, Math.max(1, Number(query.limit) || 20));
          else query.limit = 20;
          const selected = exec.agent?.options;
          const model: ModelSelection | null =
            selected?.provider && selected.model
              ? {
                  provider: selected.provider,
                  model: selected.model,
                  ...(selected.reasoningEffort
                    ? { reasoningEffort: selected.reasoningEffort }
                    : {}),
                }
              : null;
          const result = await service.invokeFor(
            { ...args, query } as InvokeInput,
            model,
            exec.signal,
          );
          // Acquisition remains bounded by the business API; do not silently truncate structured results.
          if (Buffer.byteLength(JSON.stringify(result)) > 262_144)
            throw new Error(
              'Result exceeds tool preview limit; use pagination or export an Artifact',
            );
          const backgroundJobId = mirrorJob(
            ctx,
            service,
            { ...args, query } as InvokeInput,
            result,
            exec,
            model,
          );
          return { ...result, ...(backgroundJobId ? { backgroundJobId } : {}) } as unknown as Json;
        },
      }),
    );
  }
  ctx.tools.register(
    defineTool({
      name: 'zhiyun_operation_schema',
      description:
        'Inspect the original business parameter and response schemas for one allowed ZhiYun operation.',
      parameters: {
        workspaceId: { type: 'string', required: true },
        operationId: {
          type: 'string',
          required: true,
          enum: catalog.map((route) => route.operationId),
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: (args, exec) =>
        service.describeOperation(args.workspaceId, args.operationId, exec.signal),
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'zhiyun_workspaces',
      description: 'List local DSH workspace IDs usable by ZhiYun.',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      execute: async () => service.workspaces(),
    }),
  );
}
