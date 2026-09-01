import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RouteContribution } from '@zhiyun/kernel';
import type { ArtifactStore, PlatformRepository } from '@zhiyun/platform-core';
import { DefaultDataExporter, type ExportOptions } from '@zhiyun/exporters';
import type { DatasetSnapshotService } from '../application/index.js';
import type { DatasetRepository } from '../contracts/index.js';

export const datasetsRoutes = [
  {
    operationId: 'listDatasets',
    method: 'GET',
    path: '/api/v2/datasets',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'getDataset',
    method: 'GET',
    path: '/api/v2/datasets/{datasetId}',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'listDatasetRecords',
    method: 'GET',
    path: '/api/v2/datasets/{datasetId}/records',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'listDatasetChanges',
    method: 'GET',
    path: '/api/v2/datasets/{datasetId}/changes',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'diffDataset',
    method: 'GET',
    path: '/api/v2/datasets/{datasetId}/diff',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'exportDataset',
    method: 'POST',
    path: '/api/v2/datasets/{datasetId}/exports',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'createDatasetSnapshot',
    method: 'POST',
    path: '/api/v2/datasets/{datasetId}/snapshots',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'listDatasetSnapshots',
    method: 'GET',
    path: '/api/v2/datasets/{datasetId}/snapshots',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'getDatasetSnapshot',
    method: 'GET',
    path: '/api/v2/datasets/{datasetId}/snapshots/{snapshotId}',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'listRunRecords',
    method: 'GET',
    path: '/api/v2/runs/{runId}/records',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'exportRunRecords',
    method: 'POST',
    path: '/api/v2/runs/{runId}/exports',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'queryDataApiRecords',
    method: 'GET',
    path: '/api/v2/data/tasks/{taskId}/records',
    requiredPermission: 'workspace.read',
  },
] as const satisfies readonly RouteContribution[];

export interface DatasetsHttpDependencies {
  repository: DatasetRepository;
  snapshots: DatasetSnapshotService;
  platform: PlatformRepository;
  artifactStore: ArtifactStore;
}

export async function registerDatasetsHttp(
  app: FastifyInstance,
  dependencies: DatasetsHttpDependencies,
): Promise<void> {
  app.get('/api/v2/datasets', async (request, reply) =>
    send(reply, async () => {
      const query = request.query as { cursor?: string; limit?: string; sourceTaskId?: string };
      if (query.sourceTaskId) {
        const dataset = await dependencies.repository.getDatasetBySourceTask(query.sourceTaskId);
        return { items: dataset ? [dataset] : [], nextCursor: null };
      }
      return dependencies.repository.listDatasets(query.cursor, parseLimit(query.limit));
    }),
  );

  app.get('/api/v2/datasets/:datasetId', async (request, reply) =>
    send(reply, async () => {
      const dataset = await dependencies.repository.getDataset(pathId(request, 'datasetId'));
      if (!dataset) throw new HttpProblem(404, 'NOT_FOUND', 'Dataset was not found');
      return dataset;
    }),
  );

  app.get('/api/v2/datasets/:datasetId/records', async (request, reply) =>
    send(reply, () => {
      const query = request.query as {
        cursor?: string;
        limit?: string;
        includeRemoved?: string;
      };
      return dependencies.repository.listRecords(
        pathId(request, 'datasetId'),
        query.cursor,
        parseLimit(query.limit),
        { includeRemoved: query.includeRemoved === 'true' },
      );
    }),
  );

  app.get('/api/v2/datasets/:datasetId/changes', async (request, reply) =>
    send(reply, () => {
      const query = request.query as { cursor?: string; limit?: string; sourceRunId?: string };
      return dependencies.repository.listChanges(
        pathId(request, 'datasetId'),
        query.cursor,
        parseLimit(query.limit),
        query.sourceRunId,
      );
    }),
  );

  app.get('/api/v2/datasets/:datasetId/diff', async (request, reply) =>
    send(reply, async () => {
      const query = request.query as { to?: string; cursor?: string; limit?: string };
      if (!query.to) throw new HttpProblem(400, 'VALIDATION_ERROR', 'to Run ID is required');
      const page = await dependencies.repository.listChanges(
        pathId(request, 'datasetId'),
        query.cursor,
        parseLimit(query.limit),
        query.to,
      );
      const stats = { added: 0, updated: 0, removed: 0 };
      for (const item of page.items) stats[item.type] += 1;
      return {
        ...page,
        items: page.items.map((item) => ({
          recordKey: item.datasetRecordId,
          type: item.type,
          before: item.before,
          after: item.after,
        })),
        stats,
      };
    }),
  );

  app.get('/api/v2/datasets/:datasetId/snapshots', async (request, reply) =>
    send(reply, () => dependencies.repository.listSnapshots(pathId(request, 'datasetId'))),
  );

  app.get('/api/v2/runs/:runId/records', async (request, reply) =>
    send(reply, () => {
      const query = request.query as { cursor?: string; limit?: string };
      return dependencies.repository.listRunRecords(
        pathId(request, 'runId'),
        query.cursor,
        parseLimit(query.limit),
      );
    }),
  );

  app.post('/api/v2/datasets/:datasetId/snapshots', async (request, reply) =>
    send(reply, async () => {
      requireIdempotencyKey(request);
      const result = await dependencies.snapshots.materialize(pathId(request, 'datasetId'));
      reply.code(result.inProgress ? 202 : 201);
      return result.snapshot;
    }),
  );

  app.get('/api/v2/datasets/:datasetId/snapshots/:snapshotId', async (request, reply) =>
    send(reply, async () => {
      const snapshot = await dependencies.repository.getSnapshot(pathId(request, 'snapshotId'));
      if (!snapshot || snapshot.datasetId !== pathId(request, 'datasetId')) {
        throw new HttpProblem(404, 'NOT_FOUND', 'Dataset Snapshot was not found');
      }
      return snapshot;
    }),
  );

  app.post('/api/v2/datasets/:datasetId/exports', async (request, reply) =>
    send(reply, async () => {
      const datasetId = pathId(request, 'datasetId');
      const dataset = await dependencies.repository.getDataset(datasetId);
      if (!dataset) throw new HttpProblem(404, 'NOT_FOUND', 'Dataset was not found');
      const body = exportOptions(request.body, `dataset-${datasetId}`);
      const artifact = await idempotentMutation(
        dependencies.platform,
        `datasets:export:${datasetId}`,
        requireIdempotencyKey(request),
        body,
        201,
        () =>
          createExportArtifact(dependencies, {
            ownerId: datasetId,
            kind: 'dataset',
            body,
            records: datasetRecordData(dependencies.repository, datasetId, request.body),
            metadata: { datasetId, schemaVersion: dataset.schemaVersion },
          }),
      );
      reply.code(201);
      return artifact;
    }),
  );

  app.post('/api/v2/runs/:runId/exports', async (request, reply) =>
    send(reply, async () => {
      const runId = pathId(request, 'runId');
      const firstPage = await dependencies.repository.listRunRecords(runId, undefined, 1);
      if (!firstPage.items.length) {
        throw new HttpProblem(404, 'NOT_FOUND', 'Run records were not found');
      }
      const body = exportOptions(request.body, `run-${runId}`);
      const artifact = await idempotentMutation(
        dependencies.platform,
        `datasets:export-run:${runId}`,
        requireIdempotencyKey(request),
        body,
        201,
        () =>
          createExportArtifact(dependencies, {
            ownerId: runId,
            kind: 'run',
            body,
            records: runRecordData(dependencies.repository, runId),
            metadata: { runId },
          }),
      );
      reply.code(201);
      return { artifactRef: artifact.id, artifact };
    }),
  );

  app.get('/api/v2/data/tasks/:taskId/records', async (request, reply) =>
    send(reply, async () => {
      const taskId = pathId(request, 'taskId');
      const principal = (request as FastifyRequest & { dataApiPrincipal?: { taskIds?: unknown } })
        .dataApiPrincipal;
      const taskIds = Array.isArray(principal?.taskIds)
        ? principal.taskIds.filter((id): id is string => typeof id === 'string')
        : [];
      if (taskIds.length && !taskIds.includes(taskId)) {
        throw new HttpProblem(403, 'FORBIDDEN', 'Token is not scoped to this Task');
      }
      const dataset = await dependencies.repository.getDatasetBySourceTask(taskId);
      if (!dataset) throw new HttpProblem(404, 'NOT_FOUND', 'Dataset was not found');
      const query = request.query as {
        cursor?: string;
        limit?: string;
        fields?: string;
        filter?: string;
        includeRemoved?: string;
      };
      const filter = query.filter ? parseFilter(query.filter) : undefined;
      const page = await dependencies.repository.listRecords(
        dataset.id,
        query.cursor,
        parseLimit(query.limit),
        {
          includeRemoved: query.includeRemoved === 'true',
          ...(filter ? { filter } : {}),
        },
      );
      const fields = query.fields?.split(',').filter(Boolean);
      const items = page.items.map((item) =>
        fields?.length
          ? {
              ...item,
              data: Object.fromEntries(fields.map((field) => [field, item.data[field]])),
            }
          : item,
      );
      return { ...page, items };
    }),
  );
}

async function createExportArtifact(
  dependencies: DatasetsHttpDependencies,
  input: {
    ownerId: string;
    kind: 'dataset' | 'run';
    body: ExportOptions;
    records: AsyncIterable<Record<string, unknown>>;
    metadata: Record<string, unknown>;
  },
) {
  const jobId = randomUUID();
  const workspace = await dependencies.artifactStore.openWorkspace(jobId);
  const exporter = new DefaultDataExporter();
  const exported = await exporter.exportStream(input.records, input.body);
  const relativePath = `export.${input.body.format}`;
  const outputPath = await workspace.resolve(relativePath);
  const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 });
  try {
    for await (const chunk of exported.data) {
      if (!output.write(chunk)) await once(output, 'drain');
    }
    output.end();
    await once(output, 'close');
    const stored = await dependencies.artifactStore.commitWorkspaceFile(
      jobId,
      relativePath,
      `${input.kind}s/${input.ownerId}/exports/${jobId}.${input.body.format}`,
    );
    return dependencies.platform.createArtifact({
      ownerPluginId: 'datasets',
      kind: `${input.kind}.export.${input.body.format}`,
      filename: exported.filename,
      contentType: exported.contentType,
      ...stored,
      metadata: input.metadata,
    });
  } finally {
    output.destroy();
    await dependencies.artifactStore.removeWorkspace(jobId).catch(() => undefined);
  }
}

async function* runRecordData(repository: DatasetRepository, runId: string) {
  let cursor: string | undefined;
  do {
    const page = await repository.listRunRecords(runId, cursor, 500);
    for (const record of page.items) yield record.data;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
}

async function* datasetRecordData(
  repository: DatasetRepository,
  datasetId: string,
  requestBody: unknown,
) {
  const body = isObject(requestBody) ? requestBody : {};
  const includeRemoved = body.includeRemoved === true;
  const query = typeof body.query === 'string' ? body.query.toLowerCase() : undefined;
  const filter = isObject(body.filter) ? body.filter : undefined;
  let cursor: string | undefined;
  do {
    const page = await repository.listRecords(datasetId, cursor, 500, { includeRemoved });
    for (const record of page.items) {
      if (query && !JSON.stringify(record.data).toLowerCase().includes(query)) continue;
      if (
        filter &&
        Object.entries(filter).some(([key, expected]) => record.data[key] !== expected)
      ) {
        continue;
      }
      yield record.data;
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
}

function exportOptions(value: unknown, filename: string): ExportOptions {
  const body = isObject(value) ? value : {};
  const format = body.format ?? 'json';
  if (format !== 'csv' && format !== 'json' && format !== 'xlsx') {
    throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid export format');
  }
  const fields = Array.isArray(body.fields)
    ? body.fields.filter((field): field is string => typeof field === 'string' && Boolean(field))
    : undefined;
  return {
    format,
    filename,
    ...(fields?.length ? { fields } : {}),
    ...(typeof body.bom === 'boolean' ? { bom: body.bom } : {}),
    ...(body.jsonMode === 'array' || body.jsonMode === 'jsonl' ? { jsonMode: body.jsonMode } : {}),
  };
}

function parseFilter(value: string): Record<string, string | number | boolean | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new HttpProblem(400, 'VALIDATION_ERROR', 'filter must be valid JSON');
  }
  if (
    !isObject(parsed) ||
    Object.keys(parsed).length > 20 ||
    Object.keys(parsed).some((key) => !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(key)) ||
    Object.values(parsed).some(
      (item) => item !== null && !['string', 'number', 'boolean'].includes(typeof item),
    )
  ) {
    throw new HttpProblem(400, 'VALIDATION_ERROR', 'filter contains an unsupported value');
  }
  return parsed as Record<string, string | number | boolean | null>;
}

async function send(reply: FastifyReply, operation: () => Promise<unknown>): Promise<unknown> {
  try {
    return await operation();
  } catch (error) {
    const problem = toProblem(error);
    return reply
      .code(problem.status)
      .type('application/problem+json')
      .send({
        ...problem,
        instance: reply.request.routeOptions.url || reply.request.url.split('?')[0],
        traceId: reply.request.id,
      });
  }
}

class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function toProblem(error: unknown) {
  const detail = error instanceof Error ? error.message : 'Dataset request failed';
  const unavailable = detail.startsWith('ANALYTICS_UNAVAILABLE:');
  const status = error instanceof HttpProblem ? error.status : unavailable ? 503 : 500;
  const code =
    error instanceof HttpProblem
      ? error.code
      : unavailable
        ? 'ANALYTICS_UNAVAILABLE'
        : 'SNAPSHOT_FAILED';
  return {
    type: `https://zhiyun.dev/problems/${code.toLowerCase().replaceAll('_', '-')}`,
    title: code,
    status,
    code,
    detail,
  };
}

function pathId(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== 'string' || !value) {
    throw new HttpProblem(400, 'VALIDATION_ERROR', `Invalid ${name}`);
  }
  return value;
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !value || value.length > 200) {
    throw new HttpProblem(428, 'PRECONDITION_REQUIRED', 'Idempotency-Key is required');
  }
  return value;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000) {
    throw new HttpProblem(400, 'VALIDATION_ERROR', 'limit must be between 1 and 1000');
  }
  return parsed;
}

async function idempotentMutation<T>(
  platform: PlatformRepository,
  scope: string,
  key: string,
  body: unknown,
  responseStatus: number,
  operation: () => Promise<T>,
): Promise<T> {
  const requestHash = createHash('sha256').update(canonicalJson(body)).digest('hex');
  const reservation = await platform.reserveIdempotency({
    scope,
    key,
    requestHash,
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  });
  if (reservation.state === 'conflict' || reservation.state === 'pending') {
    throw new HttpProblem(409, 'IDEMPOTENCY_CONFLICT', 'Idempotent mutation conflicts');
  }
  if (reservation.state === 'completed') return reservation.responseBody as T;
  const response = await operation();
  await platform.completeIdempotency({
    scope,
    key,
    requestHash,
    responseStatus,
    responseBody: response,
  });
  return response;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
