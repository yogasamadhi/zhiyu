import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RouteContribution } from '@zhiyun/kernel';
import {
  recruitmentFileInputSchema,
  recruitmentImportMappingInputSchema,
  recruitmentSearchProfileInputSchema,
  recruitmentSourceKeySchema,
  recruitmentWorkflowUpdateSchema,
  type RecruitmentSourceKey,
  type RecruitmentWorkflowState,
} from '@zhiyun/shared';
import { z } from 'zod';
import { RecruitmentServiceError } from '../application/index.js';
import type { RecruitmentService } from '../application/index.js';

export const recruitmentRoutes = [
  {
    operationId: 'listRecruitmentSources',
    method: 'GET',
    path: '/api/v2/recruitment/sources',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'getRecruitmentSource',
    method: 'GET',
    path: '/api/v2/recruitment/sources/{sourceKey}',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'syncRecruitmentSource',
    method: 'POST',
    path: '/api/v2/recruitment/sources/{sourceKey}/sync',
    requiredPermission: 'run.execute',
  },
  {
    operationId: 'listRecruitmentSearchProfiles',
    method: 'GET',
    path: '/api/v2/recruitment/search-profiles',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'createRecruitmentSearchProfile',
    method: 'POST',
    path: '/api/v2/recruitment/search-profiles',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'getRecruitmentSearchProfile',
    method: 'GET',
    path: '/api/v2/recruitment/search-profiles/{profileId}',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'updateRecruitmentSearchProfile',
    method: 'PATCH',
    path: '/api/v2/recruitment/search-profiles/{profileId}',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'deleteRecruitmentSearchProfile',
    method: 'DELETE',
    path: '/api/v2/recruitment/search-profiles/{profileId}',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'previewRecruitmentImport',
    method: 'POST',
    path: '/api/v2/recruitment/imports/preview',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'createRecruitmentImport',
    method: 'POST',
    path: '/api/v2/recruitment/imports',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'getRecruitmentImport',
    method: 'GET',
    path: '/api/v2/recruitment/imports/{importId}',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'getRecruitmentImportErrors',
    method: 'GET',
    path: '/api/v2/recruitment/imports/{importId}/errors',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'listRecruitmentImportMappings',
    method: 'GET',
    path: '/api/v2/recruitment/import-mappings',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'createRecruitmentImportMapping',
    method: 'POST',
    path: '/api/v2/recruitment/import-mappings',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'updateRecruitmentImportMapping',
    method: 'PATCH',
    path: '/api/v2/recruitment/import-mappings/{mappingId}',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'deleteRecruitmentImportMapping',
    method: 'DELETE',
    path: '/api/v2/recruitment/import-mappings/{mappingId}',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'listRecruitmentJobClusters',
    method: 'GET',
    path: '/api/v2/recruitment/job-clusters',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'getRecruitmentJobCluster',
    method: 'GET',
    path: '/api/v2/recruitment/job-clusters/{clusterId}',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'updateRecruitmentWorkflowState',
    method: 'PUT',
    path: '/api/v2/recruitment/job-clusters/{clusterId}/state',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'mergeRecruitmentJobClusters',
    method: 'POST',
    path: '/api/v2/recruitment/job-clusters/merge',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'splitRecruitmentJobCluster',
    method: 'POST',
    path: '/api/v2/recruitment/job-clusters/{clusterId}/split',
    requiredPermission: 'task.write',
  },
] as const satisfies readonly RouteContribution[];

const profileUpdateSchema = z.object({
  revision: z.number().int().positive(),
  profile: recruitmentSearchProfileInputSchema,
});
const mappingUpdateSchema = z.object({
  revision: z.number().int().positive(),
  mapping: recruitmentImportMappingInputSchema,
});
const mergeSchema = z.object({
  targetClusterId: z.string().uuid(),
  sourceClusterIds: z.array(z.string().uuid()).min(1).max(100),
});
const splitSchema = z.object({ postingIds: z.array(z.string().uuid()).min(1).max(100) });

export async function registerRecruitmentHttp(
  app: FastifyInstance,
  service: RecruitmentService,
): Promise<void> {
  app.get('/api/v2/recruitment/sources', async (request, reply) =>
    send(reply, () => service.listSources(queryString(request, 'profileId') ?? undefined)),
  );
  app.get('/api/v2/recruitment/sources/:sourceKey', async (request, reply) =>
    send(reply, async () => {
      const source = await service.getSource(
        sourceKey(request),
        queryString(request, 'profileId') ?? undefined,
      );
      if (!source) throw new RecruitmentServiceError(404, 'NOT_FOUND', '招聘来源不存在');
      return source;
    }),
  );
  app.post('/api/v2/recruitment/sources/:sourceKey/sync', async (request, reply) =>
    send(reply, async () => reply.code(202).send(await service.syncSource(sourceKey(request)))),
  );

  app.get('/api/v2/recruitment/search-profiles', async (_request, reply) =>
    send(reply, () => service.listProfiles()),
  );
  app.post('/api/v2/recruitment/search-profiles', async (request, reply) =>
    send(reply, async () => {
      const profile = await service.createProfile(
        recruitmentSearchProfileInputSchema.parse(request.body),
      );
      return reply.code(201).header('etag', `"${profile.revision}"`).send(profile);
    }),
  );
  app.get('/api/v2/recruitment/search-profiles/:profileId', async (request, reply) =>
    send(reply, async () => {
      const profile = await service.getProfile(pathId(request, 'profileId'));
      return reply.header('etag', `"${profile.revision}"`).send(profile);
    }),
  );
  app.patch('/api/v2/recruitment/search-profiles/:profileId', async (request, reply) =>
    send(reply, async () => {
      const input = profileUpdateSchema.parse(request.body);
      const profile = await service.updateProfile(
        pathId(request, 'profileId'),
        input.profile,
        input.revision,
      );
      return reply.header('etag', `"${profile.revision}"`).send(profile);
    }),
  );
  app.delete('/api/v2/recruitment/search-profiles/:profileId', async (request, reply) =>
    send(reply, async () => {
      if (!(await service.deleteProfile(pathId(request, 'profileId')))) {
        throw new RecruitmentServiceError(404, 'NOT_FOUND', '搜索档案不存在');
      }
      return reply.code(204).send();
    }),
  );

  const largeBody = { bodyLimit: 72 * 1024 * 1024 };
  app.post('/api/v2/recruitment/imports/preview', largeBody, async (request, reply) =>
    send(reply, () => service.previewFile(recruitmentFileInputSchema.parse(request.body))),
  );
  app.post('/api/v2/recruitment/imports', largeBody, async (request, reply) =>
    send(reply, async () =>
      reply
        .code(201)
        .send(await service.importFile(recruitmentFileInputSchema.parse(request.body))),
    ),
  );
  app.get('/api/v2/recruitment/imports/:importId', async (request, reply) =>
    send(reply, async () => {
      const job = await service.getImportJob(pathId(request, 'importId'));
      if (!job) throw new RecruitmentServiceError(404, 'NOT_FOUND', '导入任务不存在');
      return job;
    }),
  );
  app.get('/api/v2/recruitment/imports/:importId/errors', async (request, reply) =>
    send(reply, async () => {
      const job = await service.getImportJob(pathId(request, 'importId'));
      if (!job) throw new RecruitmentServiceError(404, 'NOT_FOUND', '导入任务不存在');
      return { items: await service.getImportErrors(job.id), artifactId: job.errorArtifactId };
    }),
  );

  app.get('/api/v2/recruitment/import-mappings', async (request, reply) =>
    send(reply, () => {
      const key = queryString(request, 'sourceKey');
      return service.listMappings(key ? recruitmentSourceKeySchema.parse(key) : undefined);
    }),
  );
  app.post('/api/v2/recruitment/import-mappings', async (request, reply) =>
    send(reply, async () =>
      reply
        .code(201)
        .send(await service.createMapping(recruitmentImportMappingInputSchema.parse(request.body))),
    ),
  );
  app.patch('/api/v2/recruitment/import-mappings/:mappingId', async (request, reply) =>
    send(reply, async () => {
      const input = mappingUpdateSchema.parse(request.body);
      return service.updateMapping(pathId(request, 'mappingId'), input.mapping, input.revision);
    }),
  );
  app.delete('/api/v2/recruitment/import-mappings/:mappingId', async (request, reply) =>
    send(reply, async () => {
      if (!(await service.deleteMapping(pathId(request, 'mappingId')))) {
        throw new RecruitmentServiceError(404, 'NOT_FOUND', '字段映射不存在');
      }
      return reply.code(204).send();
    }),
  );

  app.get('/api/v2/recruitment/job-clusters', async (request, reply) =>
    send(reply, () => {
      const query = request.query as Record<string, string | undefined>;
      return service.listClusters({
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.limit ? { limit: integerQuery(query.limit, 'limit', 1, 200) } : {}),
        ...(query.profileId ? { profileId: query.profileId } : {}),
        ...(query.sourceKey
          ? { sourceKey: recruitmentSourceKeySchema.parse(query.sourceKey) }
          : {}),
        ...(query.workflowState
          ? { workflowState: query.workflowState as RecruitmentWorkflowState }
          : {}),
        ...(query.city ? { city: query.city } : {}),
        ...(query.keyword ? { keyword: query.keyword } : {}),
        ...(query.salaryMin
          ? { salaryMin: integerQuery(query.salaryMin, 'salaryMin', 0, 10_000_000) }
          : {}),
        ...(query.salaryMax
          ? { salaryMax: integerQuery(query.salaryMax, 'salaryMax', 0, 10_000_000) }
          : {}),
        ...(query.publishedAfter
          ? { publishedAfter: dateTimeQuery(query.publishedAfter, 'publishedAfter') }
          : {}),
        ...(query.publishedBefore
          ? { publishedBefore: dateTimeQuery(query.publishedBefore, 'publishedBefore') }
          : {}),
        ...(query.includeArchived ? { includeArchived: query.includeArchived === 'true' } : {}),
      });
    }),
  );
  app.get('/api/v2/recruitment/job-clusters/:clusterId', async (request, reply) =>
    send(reply, () =>
      service.getCluster(
        pathId(request, 'clusterId'),
        queryString(request, 'profileId') ?? undefined,
      ),
    ),
  );
  app.put('/api/v2/recruitment/job-clusters/:clusterId/state', async (request, reply) =>
    send(reply, () =>
      service.setWorkflowState(
        pathId(request, 'clusterId'),
        recruitmentWorkflowUpdateSchema.parse(request.body),
      ),
    ),
  );
  app.post('/api/v2/recruitment/job-clusters/merge', async (request, reply) =>
    send(reply, () => {
      const input = mergeSchema.parse(request.body);
      return service.mergeClusters(input.targetClusterId, input.sourceClusterIds);
    }),
  );
  app.post('/api/v2/recruitment/job-clusters/:clusterId/split', async (request, reply) =>
    send(reply, () => {
      const input = splitSchema.parse(request.body);
      return service.splitCluster(pathId(request, 'clusterId'), input.postingIds);
    }),
  );
}

function sourceKey(request: FastifyRequest): RecruitmentSourceKey {
  return recruitmentSourceKeySchema.parse(pathId(request, 'sourceKey'));
}

function pathId(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== 'string' || !value) {
    throw new RecruitmentServiceError(400, 'VALIDATION_ERROR', `Missing ${name}`);
  }
  return value;
}

function queryString(request: FastifyRequest, name: string): string | null {
  const value = (request.query as Record<string, unknown>)[name];
  return typeof value === 'string' && value ? value : null;
}

function integerQuery(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RecruitmentServiceError(
      400,
      'VALIDATION_ERROR',
      `${name} must be between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function dateTimeQuery(value: string, name: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new RecruitmentServiceError(400, 'VALIDATION_ERROR', `${name} must be an ISO date`);
  }
  return new Date(timestamp).toISOString();
}

async function send(reply: FastifyReply, action: () => Promise<unknown> | unknown) {
  try {
    return await action();
  } catch (error) {
    const problem =
      error instanceof RecruitmentServiceError
        ? error
        : error instanceof z.ZodError
          ? new RecruitmentServiceError(
              400,
              'VALIDATION_ERROR',
              '招聘请求参数无效',
              error.flatten(),
            )
          : null;
    if (!problem) throw error;
    return reply
      .code(problem.status)
      .type('application/problem+json')
      .send({
        type: `https://zhiyun.local/problems/${problem.code.toLowerCase().replaceAll('_', '-')}`,
        title: problem.code,
        status: problem.status,
        detail: problem.message,
        instance: reply.request.url,
        code: problem.code,
        traceId: String(reply.getHeader('x-trace-id') ?? ''),
        ...(problem.errors ? { errors: problem.errors } : {}),
      });
  }
}
