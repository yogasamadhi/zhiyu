import { readFile } from 'node:fs/promises';
import { recordQuerySchema, type RecordQuery, type DatasetSchemaDescription } from '@zhiyun/shared';
import { compareDatasetRuns } from '../application/diff.js';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RouteContribution } from '@zhiyun/kernel';
import type { ArtifactStore, PlatformRepository } from '@zhiyun/platform-core';
import { DefaultDataExporter, type ExportOptions } from '@zhiyun/exporters';
import type { DatasetSnapshotService } from '../application/index.js';
import type { DatasetRepository } from '../contracts/index.js';
import type { DatasetCleaningService } from '../application/cleaning.js';
import { datasetCleaningRoutes, registerDatasetCleaningHttp } from './cleaning.js';

export const datasetsRoutes = [
  ...datasetCleaningRoutes,
  {
    operationId: 'getDatasetFields',
    method: 'GET',
    path: '/api/v2/datasets/{datasetId}/fields',
    requiredPermission: 'workspace.read',
  },
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
  cleaning?: DatasetCleaningService;
  repository: DatasetRepository;
  snapshots: DatasetSnapshotService;
  platform: PlatformRepository;
  artifactStore: ArtifactStore;
  onExported?(taskId: string, artifactId: string): Promise<void>;
  onRunExported?(runId: string, artifactId: string): Promise<void>;
  taskSummaries?(
    query?: string,
    ids?: readonly string[],
  ): Promise<Array<{ id: string; name: string }>>;
  qualitySummaries?(taskIds: readonly string[]): Promise<Array<{ taskId: string; status: string }>>;
}

export async function registerDatasetsHttp(
  app: FastifyInstance,
  dependencies: DatasetsHttpDependencies,
): Promise<void> {
  await registerDatasetCleaningHttp(app, dependencies.cleaning, dependencies.platform);
  app.get('/api/v2/datasets', async (request, reply) =>
    send(reply, async () => {
      const query = request.query as {
        cursor?: string;
        limit?: string;
        sourceTaskId?: string;
        query?: string;
        sort?: string;
        direction?: string;
      };
      if (query.sort && !['updatedAt', 'currentCount'].includes(query.sort))
        throw new HttpProblem(400, 'VALIDATION_ERROR', 'Unsupported dataset sort');
      if (query.direction && !['asc', 'desc'].includes(query.direction))
        throw new HttpProblem(400, 'VALIDATION_ERROR', 'Unsupported sort direction');
      const matching = query.query
        ? ((await dependencies.taskSummaries?.(query.query)) ?? [])
        : undefined;
      const page = await dependencies.repository.listDatasets(
        query.cursor,
        parseLimit(query.limit),
        {
          ...(query.sourceTaskId
            ? { sourceTaskIds: [query.sourceTaskId] }
            : matching
              ? { sourceTaskIds: matching.map((t) => t.id) }
              : {}),
          ...(query.sort ? { sort: query.sort as 'updatedAt' | 'currentCount' } : {}),
          ...(query.direction ? { direction: query.direction as 'asc' | 'desc' } : {}),
        },
      );
      const taskIds = page.items.map((d) => d.sourceTaskId);
      const summaries = (await dependencies.taskSummaries?.(undefined, taskIds)) ?? [];
      const quality = (await dependencies.qualitySummaries?.(taskIds)) ?? [];
      return {
        ...page,
        items: page.items.map((dataset) => ({
          ...dataset,
          name: summaries.find((t) => t.id === dataset.sourceTaskId)?.name ?? null,
          qualityStatus:
            quality.find((q) => q.taskId === dataset.sourceTaskId)?.status ?? 'unassessed',
        })),
      };
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
      const query = request.query as Record<string, string>;
      return dependencies.repository.listRecords(
        pathId(request, 'datasetId'),
        query.cursor,
        parseLimit(query.limit),
        parseRecordQuery(query),
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
      const query = request.query as {
        from?: string;
        to?: string;
        cursor?: string;
        limit?: string;
      };
      if (!query.to) throw new HttpProblem(400, 'VALIDATION_ERROR', 'to Run ID is required');
      return compareDatasetRuns(
        dependencies.repository,
        pathId(request, 'datasetId'),
        query.from,
        query.to,
        query.cursor,
        parseLimit(query.limit),
      );
    }),
  );

  app.get('/api/v2/datasets/:datasetId/fields', async (request, reply) =>
    send(reply, async () => {
      const datasetId = pathId(request, 'datasetId');
      if (!(await dependencies.repository.getDataset(datasetId)))
        throw new HttpProblem(404, 'NOT_FOUND', 'Dataset was not found');
      const { snapshotId } = request.query as { snapshotId?: string };
      if (snapshotId) {
        const snapshot = await dependencies.repository.getSnapshot(snapshotId);
        if (!snapshot || snapshot.datasetId !== datasetId)
          throw new HttpProblem(404, 'NOT_FOUND', 'Data version was not found');
        if (snapshot.status !== 'ready' || !snapshot.manifestArtifactId)
          throw new HttpProblem(409, 'SNAPSHOT_NOT_READY', 'Data version is not ready');
        const artifact = await dependencies.platform.getArtifact(snapshot.manifestArtifactId);
        if (!artifact) throw new HttpProblem(404, 'NOT_FOUND', 'Schema manifest was not found');
        const manifest = JSON.parse(
          await readFile(
            await dependencies.artifactStore.resolveArtifact(artifact.storageKey),
            'utf8',
          ),
        ) as {
          rowCount: number;
          columns: Array<{
            sourceField: string;
            physicalName?: string;
            type: string;
            nullCount: number;
          }>;
        };
        return {
          datasetId,
          snapshotId,
          sampled: false,
          sampleCount: manifest.rowCount,
          fields: manifest.columns.map((f) => ({
            name: f.physicalName ?? f.sourceField,
            label: f.sourceField,
            type: fieldKind(f.type),
            missingCount: f.nullCount,
            sampleCount: manifest.rowCount,
          })),
        } satisfies DatasetSchemaDescription;
      }
      const page = await dependencies.repository.listRecords(datasetId, undefined, 200);
      const names = [...new Set(page.items.flatMap((r) => Object.keys(r.data)))];
      return {
        datasetId,
        snapshotId: null,
        sampled: true,
        sampleCount: page.items.length,
        fields: names.map((name) => {
          const values = page.items.map((r) => r.data[name]);
          const types = new Set(
            values.filter((v) => v !== null && v !== undefined && v !== '').map(valueKind),
          );
          return {
            name,
            type: types.size > 1 ? 'mixed' : ([...types][0] ?? 'unknown'),
            missingCount: values.filter((v) => v === null || v === undefined || v === '').length,
            sampleCount: values.length,
          };
        }),
      } satisfies DatasetSchemaDescription;
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
        { body, query: parseRecordQuery(isObject(request.body) ? request.body : {}) },
        201,
        () =>
          dependencies.repository.withConsistentSnapshotRead(
            datasetId,
            (read) =>
              createExportArtifact(dependencies, {
                ownerId: datasetId,
                kind: 'dataset',
                body,
                records: exportRecordData(read.records),
                metadata: { datasetId, schemaVersion: dataset.schemaVersion },
              }),
            parseRecordQuery(isObject(request.body) ? request.body : {}),
          ),
      );
      await dependencies.onExported?.(dataset.sourceTaskId, artifact.id).catch(() => undefined);
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
      await dependencies.onRunExported?.(runId, artifact.id).catch(() => undefined);
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

export async function createExportArtifact(
  dependencies: Pick<DatasetsHttpDependencies, 'platform' | 'artifactStore'>,
  input: {
    artifactId?: string;
    ownerId: string;
    kind: 'dataset' | 'run';
    body: ExportOptions;
    records: AsyncIterable<Record<string, unknown>>;
    metadata: Record<string, unknown>;
  },
) {
  if (input.artifactId) {
    const existing = await dependencies.platform.getArtifact(input.artifactId);
    if (existing) return existing;
  }
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
      ...(input.artifactId ? { id: input.artifactId } : {}),
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

export async function* exportRecordData(records: AsyncIterable<{ data: Record<string, unknown> }>) {
  for await (const record of records) yield record.data;
}
function parseRecordQuery(input: Record<string, unknown>): RecordQuery {
  try {
    return recordQuerySchema.parse({
      ...input,
      includeRemoved: input.includeRemoved === true || input.includeRemoved === 'true',
      filter: typeof input.filter === 'string' ? JSON.parse(input.filter) : input.filter,
      filters: typeof input.filters === 'string' ? JSON.parse(input.filters) : input.filters,
      sort: typeof input.sort === 'string' ? JSON.parse(input.sort) : input.sort,
    });
  } catch {
    throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid query, filter or sort');
  }
}
function fieldKind(type: string): DatasetSchemaDescription['fields'][number]['type'] {
  if (['int', 'integer', 'float', 'float64', 'int64', 'number'].includes(type)) return 'number';
  if (['date', 'datetime', 'timestamp'].includes(type)) return 'date';
  if (['bool', 'boolean'].includes(type)) return 'boolean';
  return ['string', 'text'].includes(type) ? 'text' : 'unknown';
}
function valueKind(value: unknown): DatasetSchemaDescription['fields'][number]['type'] {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string')
    return /^\d{4}-\d{2}-\d{2}(T|$)/.test(value) && Number.isFinite(Date.parse(value))
      ? 'date'
      : 'text';
  return 'unknown';
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
    Object.keys(parsed).some((key) => !key || key.length > 256 || key.includes('\0')) ||
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
  if (
    detail.startsWith('VALIDATION_ERROR:') ||
    detail.includes('query cursor') ||
    detail.startsWith('Record query changed')
  )
    error = new HttpProblem(400, 'VALIDATION_ERROR', detail);
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
