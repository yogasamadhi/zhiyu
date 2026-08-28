import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RouteContribution } from '@zhiyun/kernel';
import {
  TREND_SOURCE_CATALOG,
  buildPreferenceProfile,
  buildTrendTerms,
  sourceCatalogEntry,
} from '@zhiyun/preferences';
import { preferenceSignalInputSchema, trendSourceUpdateSchema } from '@zhiyun/shared';
import type { PreferencesRepository, PreferencesServiceContract } from '../contracts/index.js';

export const preferencesRoutes = [
  { operationId: 'getPreferenceProfile', method: 'GET', path: '/api/v2/preferences/profile' },
  { operationId: 'listPreferenceSignals', method: 'GET', path: '/api/v2/preferences/signals' },
  { operationId: 'createPreferenceSignal', method: 'POST', path: '/api/v2/preferences/signals' },
  {
    operationId: 'deletePreferenceSignal',
    method: 'DELETE',
    path: '/api/v2/preferences/signals/{signalId}',
  },
  {
    operationId: 'clearPreferenceSignals',
    method: 'DELETE',
    path: '/api/v2/preferences/signals',
  },
  { operationId: 'listTrends', method: 'GET', path: '/api/v2/trends' },
  { operationId: 'listTrendSources', method: 'GET', path: '/api/v2/trend-sources' },
  {
    operationId: 'bootstrapTrendSources',
    method: 'POST',
    path: '/api/v2/trend-sources/bootstrap',
  },
  {
    operationId: 'updateTrendSource',
    method: 'PUT',
    path: '/api/v2/trend-sources/{sourceKey}',
  },
  {
    operationId: 'runTrendSource',
    method: 'POST',
    path: '/api/v2/trend-sources/{sourceKey}/run',
  },
  { operationId: 'runTrendSources', method: 'POST', path: '/api/v2/trend-sources/run' },
  { operationId: 'importPreference', method: 'POST', path: '/api/v2/preferences/import' },
] as const satisfies readonly RouteContribution[];

export interface PreferencesHttpDependencies {
  repository: PreferencesRepository;
  service: PreferencesServiceContract;
  trendItems?(): Promise<Array<Record<string, unknown>>>;
  bootstrapTrendSource?(key: string): Promise<{ taskId: string | null }>;
  runTrendSource?(key: string): Promise<Record<string, unknown>>;
  importPreference?(body: unknown): Promise<unknown>;
}

export async function registerPreferencesHttp(
  app: FastifyInstance,
  dependencies: PreferencesHttpDependencies,
): Promise<void> {
  app.get('/api/v2/preferences/signals', async (request, reply) =>
    send(reply, () => {
      const query = request.query as { cursor?: string; limit?: string };
      return dependencies.service.listSignals(query.cursor, parseLimit(query.limit));
    }),
  );
  app.post('/api/v2/preferences/signals', async (request, reply) =>
    send(reply, async () => {
      requireIdempotencyKey(request);
      return dependencies.service.setSignal(preferenceSignalInputSchema.parse(request.body));
    }),
  );
  app.delete('/api/v2/preferences/signals/:signalId', async (request, reply) =>
    send(reply, async () => {
      requireIdempotencyKey(request);
      const deleted = await dependencies.service.deleteSignal(pathId(request, 'signalId'));
      if (!deleted) throw new HttpProblem(404, 'NOT_FOUND', 'Preference Signal was not found');
      reply.code(204);
      return undefined;
    }),
  );
  app.delete('/api/v2/preferences/signals', async (request, reply) =>
    send(reply, async () => {
      requireIdempotencyKey(request);
      return { deleted: await dependencies.service.clearSignals() };
    }),
  );
  app.get('/api/v2/preferences/profile', async (_request, reply) =>
    send(reply, async () => {
      const page = await dependencies.service.listSignals(undefined, 10_000);
      return buildPreferenceProfile(page.items);
    }),
  );
  app.get('/api/v2/trend-sources', async (_request, reply) =>
    send(reply, () => trendSourceViews(dependencies.repository)),
  );
  app.post('/api/v2/trend-sources/bootstrap', async (request, reply) =>
    send(reply, async () => {
      requireIdempotencyKey(request);
      const runs: Record<string, unknown>[] = [];
      for (const entry of TREND_SOURCE_CATALOG.filter(({ supported }) => supported)) {
        const installed = await dependencies.bootstrapTrendSource?.(entry.key);
        await dependencies.repository.upsertTrendSourceBinding({
          key: entry.key,
          platform: entry.platform,
          taskId: installed?.taskId ?? null,
          enabled: true,
          autoRefresh: true,
        });
        if (dependencies.runTrendSource) runs.push(await dependencies.runTrendSource(entry.key));
      }
      return { sources: await trendSourceViews(dependencies.repository), runs };
    }),
  );
  app.put('/api/v2/trend-sources/:sourceKey', async (request, reply) =>
    send(reply, async () => {
      requireIdempotencyKey(request);
      const key = pathId(request, 'sourceKey');
      const entry = sourceCatalogEntry(key);
      if (!entry) throw new HttpProblem(404, 'NOT_FOUND', 'Trend Source was not found');
      const input = trendSourceUpdateSchema.parse(request.body);
      const existing = await dependencies.repository.getTrendSourceBinding(key);
      const binding = existing
        ? await dependencies.repository.updateTrendSourceBinding(key, {
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...(input.autoRefresh === undefined ? {} : { autoRefresh: input.autoRefresh }),
          })
        : await dependencies.repository.upsertTrendSourceBinding({
            key,
            platform: entry.platform,
            taskId: null,
            enabled: input.enabled ?? true,
            autoRefresh: input.autoRefresh ?? true,
          });
      if (!binding) throw new HttpProblem(404, 'NOT_FOUND', 'Trend Source was not found');
      return (await trendSourceViews(dependencies.repository)).find((source) => source.key === key);
    }),
  );
  app.post('/api/v2/trend-sources/:sourceKey/run', async (request, reply) =>
    send(reply, async () => {
      requireIdempotencyKey(request);
      const key = pathId(request, 'sourceKey');
      if (!sourceCatalogEntry(key))
        throw new HttpProblem(404, 'NOT_FOUND', 'Trend Source not found');
      return dependencies.runTrendSource
        ? dependencies.runTrendSource(key)
        : { key, status: 'skipped', reason: 'not-installed' };
    }),
  );
  app.post('/api/v2/trend-sources/run', async (request, reply) =>
    send(reply, async () => {
      requireIdempotencyKey(request);
      const bindings = await dependencies.repository.listTrendSourceBindings();
      const runs = await Promise.all(
        bindings
          .filter(({ enabled }) => enabled)
          .map(({ key }) =>
            dependencies.runTrendSource
              ? dependencies.runTrendSource(key)
              : Promise.resolve({ key, status: 'skipped', reason: 'not-installed' }),
          ),
      );
      return { runs };
    }),
  );
  app.get('/api/v2/trends', async (request, reply) =>
    send(reply, async () => {
      const query = request.query as { platform?: string; contentType?: string; limit?: string };
      const limit = parseLimit(query.limit) ?? 100;
      const items = (await dependencies.trendItems?.()) ?? [];
      const filtered = items
        .filter((item) => !query.platform || item.platform === query.platform)
        .filter((item) => !query.contentType || item.contentType === query.contentType)
        .slice(0, limit);
      return {
        items: filtered,
        terms: buildTrendTerms(filtered as never[]),
        generatedAt: new Date().toISOString(),
      };
    }),
  );
  app.post('/api/v2/preferences/import', async (request, reply) =>
    send(reply, async () => {
      requireIdempotencyKey(request);
      if (!dependencies.importPreference) {
        throw new HttpProblem(422, 'VALIDATION_ERROR', 'Preference URL import is unavailable');
      }
      return dependencies.importPreference(request.body);
    }),
  );
}

async function trendSourceViews(repository: PreferencesRepository) {
  const bindings = new Map(
    (await repository.listTrendSourceBindings()).map((binding) => [binding.key, binding]),
  );
  return TREND_SOURCE_CATALOG.map((entry) => {
    const binding = bindings.get(entry.key);
    return {
      key: entry.key,
      platform: entry.platform,
      name: entry.name,
      description: entry.description,
      supported: entry.supported,
      enabled: entry.supported ? (binding?.enabled ?? true) : false,
      autoRefresh: entry.supported ? (binding?.autoRefresh ?? true) : false,
      scheduleLabel: entry.scheduleLabel,
      taskId: binding?.taskId ?? null,
      status: entry.supported ? (binding?.taskId ? 'idle' : 'not-installed') : 'planned',
      lastRunId: null,
      lastSucceededAt: null,
      lastError: null,
    };
  });
}

async function send(reply: FastifyReply, operation: () => Promise<unknown>): Promise<unknown> {
  try {
    return await operation();
  } catch (error) {
    const status = error instanceof PreferencesHttpError ? error.status : 400;
    const code = error instanceof PreferencesHttpError ? error.code : 'VALIDATION_ERROR';
    const detail = error instanceof Error ? error.message : 'Preference request failed';
    return reply
      .code(status)
      .type('application/problem+json')
      .send({
        type: `https://zhiyun.dev/problems/${code.toLowerCase().replaceAll('_', '-')}`,
        title: code,
        status,
        code,
        detail,
        instance: reply.request.routeOptions.url || reply.request.url.split('?')[0],
        traceId: reply.request.id,
      });
  }
}

export class PreferencesHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class HttpProblem extends PreferencesHttpError {}

function pathId(request: FastifyRequest, key: string): string {
  const value = (request.params as Record<string, unknown>)[key];
  if (typeof value !== 'string' || !value)
    throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid ID');
  return value;
}

function requireIdempotencyKey(request: FastifyRequest): void {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !value || value.length > 200) {
    throw new HttpProblem(428, 'PRECONDITION_REQUIRED', 'Idempotency-Key is required');
  }
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) {
    throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid list limit');
  }
  return parsed;
}
