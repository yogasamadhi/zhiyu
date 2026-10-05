import { summarizeExperience } from '@zhiyun/platform-core';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import cors from '@fastify/cors';
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
} from '@opentelemetry/api';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  activateGraph,
  type ActiveGraph,
  type ResolvedGraph,
  type RouteContribution,
} from '@zhiyun/kernel';
import type { ArtifactStore, PlatformJobQueue, PlatformRepository } from '@zhiyun/platform-core';
import { resolveProductGraph } from '@zhiyun/product-profiles';
import type { RuntimeCapabilities, RuntimeMetadata } from '@zhiyun/shared';

const requestTraceIds = new WeakMap<FastifyRequest, string>();
const workspacePermissions = new WeakMap<FastifyRequest, readonly string[]>();

export interface RuntimeRealtimeEvent {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export class RealtimeEventHub {
  private sequence = 0;
  private readonly listeners = new Set<(event: RuntimeRealtimeEvent) => void>();

  publish(type: string, payload: Record<string, unknown>): void {
    const event = { id: ++this.sequence, type, payload, occurredAt: new Date().toISOString() };
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: (event: RuntimeRealtimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export interface RuntimeMigration {
  pluginId: string;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export interface WorkspaceAuthorization {
  readonly sessionCookieName?: string;
  authenticate(input: {
    sessionToken: string | undefined;
    csrfToken: string | undefined;
    mutation: boolean;
  }): Promise<
    | { ok: true; principal: Record<string, unknown>; permissions: readonly string[] }
    | {
        ok: false;
        status: 401 | 403;
        code: string;
        detail: string;
        principal?: Record<string, unknown>;
      }
  >;
  audit?(input: {
    principal: Record<string, unknown>;
    operationId: string;
    resourceType: string;
    resourceId: string | null;
    result: 'succeeded' | 'failed' | 'denied';
    statusCode: number;
    traceId: string;
    network: string;
  }): Promise<void>;
}

export interface RuntimeReadinessProbe {
  readonly queue: Readonly<Record<string, unknown>> & { status: 'ok' | 'error' };
}

interface WorkspaceAuditState {
  readonly principal: Record<string, unknown>;
  readonly operationId: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly traceId: string;
  readonly network: string;
}

export interface RuntimeGatewayDependencies {
  platform: PlatformRepository;
  artifactStore: ArtifactStore;
  jobs: PlatformJobQueue;
  migrations: readonly RuntimeMigration[];
  registerPluginHttp(app: FastifyInstance): Promise<void>;
  recordExperienceEntry?(draftId: string): Promise<void>;
  metadata: Omit<
    RuntimeMetadata,
    'profileId' | 'graphRevision' | 'enabledPluginIds' | 'enabledUiContributionIds'
  >;
  capabilities: RuntimeCapabilities;
  openApiDocument: unknown;
  realtime?: RealtimeEventHub;
  beforeJobsStart?(): Promise<void>;
  saveArtifact?(artifact: {
    id: string;
    filename: string;
    contentType: string;
    size: number;
    storageKey: string;
    createdAt: string;
    metadata: Record<string, unknown>;
  }): Promise<{ saved: boolean }>;
  authenticateDataToken?(
    token: string,
  ): Promise<
    | { ok: true; principal: Record<string, unknown> }
    | { ok: false; status: 401 | 429; code: string; detail: string }
  >;
  workspaceAuthorization?: WorkspaceAuthorization;
  readiness?(): Promise<RuntimeReadinessProbe>;
  effects?: readonly { start(): void | Promise<void>; close(): Promise<void> }[];
}

export interface RuntimeGatewayOptions {
  sessionNonce: string;
  profileId: string;
  allowedOrigins: string[];
  reusableSessionNonce?: boolean;
  adminToken?: string;
  logger?: boolean | Record<string, unknown>;
  trustProxy?: boolean;
}

export interface RuntimeGateway {
  app: FastifyInstance;
  graph: { profileId: string; revision: string; pluginIds: readonly string[] };
  listen(options?: { host?: string; port?: number }): Promise<string>;
  close(): Promise<void>;
  issueSessionNonce(nonce: string): void;
  setAnalyticsWorkerStatus(status: RuntimeMetadata['analyticsWorkerStatus']): void;
}

export async function buildRuntimeGateway(
  dependencies: RuntimeGatewayDependencies,
  options: RuntimeGatewayOptions,
): Promise<RuntimeGateway> {
  const graph = resolveProductGraph(options.profileId);
  const realtime = dependencies.realtime ?? new RealtimeEventHub();
  const app = Fastify({
    logger: secureRuntimeLogger(options.logger ?? false),
    trustProxy: options.trustProxy ?? false,
  });
  const stagedApiRoutes = new Set<string>();
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      const normalized = String(method).toUpperCase();
      if (route.url.startsWith('/api/') && normalized !== 'HEAD' && normalized !== 'OPTIONS') {
        stagedApiRoutes.add(`${normalized} ${route.url}`);
      }
    }
  });
  const tracer = trace.getTracer('zhiyun.runtime-gateway', dependencies.metadata.productVersion);
  const requestSpans = new WeakMap<FastifyRequest, Span>();
  const workspaceAuditStates = new WeakMap<FastifyRequest, WorkspaceAuditState>();
  const validSessionNonces = new Set([options.sessionNonce]);
  const sessionToken = randomBytes(48).toString('base64url');
  let issuedToken = false;
  let tokenExpiresAt = 0;
  let acceptingMutations = true;
  const pluginIds = graph.plugins.map(({ descriptor }) => descriptor.id);
  const runtimeMetadata: RuntimeMetadata = {
    ...dependencies.metadata,
    profileId: graph.profile.id,
    graphRevision: graph.revision,
    enabledPluginIds: pluginIds,
    enabledUiContributionIds: graph.plugins.flatMap(
      ({ descriptor }) => descriptor.uiContributions?.map(({ id }) => id) ?? [],
    ),
  };

  await app.register(cors, {
    origin(origin, callback) {
      callback(null, !origin || options.allowedOrigins.includes(origin));
    },
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: Boolean(dependencies.workspaceAuthorization),
    allowedHeaders: [
      'authorization',
      'content-type',
      'idempotency-key',
      'if-match',
      'x-csrf-token',
      'traceparent',
      'tracestate',
    ],
    exposedHeaders: ['etag', 'content-disposition', 'x-runtime-generation', 'x-trace-id'],
  });

  app.addHook('onRequest', (request, reply, done) => {
    const parentContext = propagation.extract(context.active(), request.headers);
    const span = tracer.startSpan(
      `${request.method} ${request.routeOptions.url || request.url.split('?')[0]}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          'http.request.method': request.method,
          'url.path': request.url.split('?')[0],
          'server.address': request.hostname,
          'zhiyun.runtime.generation': dependencies.metadata.generation,
          'zhiyun.runtime.profile': graph.profile.id,
        },
      },
      parentContext,
    );
    requestSpans.set(request, span);
    const spanTraceId = span.spanContext().traceId;
    const traceId = validTraceId(spanTraceId) ? spanTraceId : incomingTraceId(request);
    requestTraceIds.set(request, traceId);
    reply.header('x-trace-id', traceId);
    context.with(trace.setSpan(parentContext, span), done);
  });
  app.addHook('onError', async (request, _reply, error) => {
    const span = requestSpans.get(request);
    span?.recordException(error);
    span?.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  });
  app.addHook('onResponse', async (request, reply) => {
    const auditState = workspaceAuditStates.get(request);
    if (auditState && dependencies.workspaceAuthorization?.audit) {
      try {
        await dependencies.workspaceAuthorization.audit({
          ...auditState,
          result: auditResult(reply.statusCode),
          statusCode: reply.statusCode,
        });
      } catch {
        app.log.error('Identity audit persistence failed');
      }
    }
    const span = requestSpans.get(request);
    if (!span) return;
    span.setAttribute('http.response.status_code', reply.statusCode);
    span.setStatus({
      code: reply.statusCode >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK,
    });
    span.end();
  });

  app.addHook('onRequest', async (request, reply) => {
    const route = routeMetadata(request, graph);
    // Fastify also executes onRequest hooks for its not-found handler and the
    // optional same-origin SPA fallback. Authentication is scoped to routes
    // owned by the resolved product graph; unknown API paths must retain their
    // 404 contract instead of leaking the active authentication mode as 401.
    if (!route) {
      const pathname = request.url.split('?')[0] ?? request.url;
      if (
        pathname.startsWith('/api/') &&
        request.routeOptions.url &&
        request.routeOptions.url !== '/*'
      ) {
        return sendProblem(request, reply, 404, 'NOT_FOUND', 'Route not found');
      }
      return;
    }
    const operationId = route.operationId;
    if (route.requiredPermission === null) return;
    const token = bearerToken(request.headers.authorization);
    if (request.url.startsWith('/api/v2/data/')) {
      const result =
        token && dependencies.authenticateDataToken
          ? await dependencies.authenticateDataToken(token)
          : {
              ok: false as const,
              status: 401 as const,
              code: 'UNAUTHORIZED',
              detail: 'Invalid Data API token',
            };
      if (!result.ok) {
        return sendProblem(request, reply, result.status, result.code, result.detail);
      }
      (request as FastifyRequest & { dataApiPrincipal: Record<string, unknown> }).dataApiPrincipal =
        result.principal;
      return;
    }
    const mutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
    if (dependencies.workspaceAuthorization) {
      const csrf = request.headers['x-csrf-token'];
      const result = await dependencies.workspaceAuthorization.authenticate({
        sessionToken: requestCookie(
          request,
          dependencies.workspaceAuthorization.sessionCookieName ?? 'zhiyun_session',
        ),
        csrfToken: Array.isArray(csrf) ? csrf[0] : csrf,
        mutation,
      });
      if (!result.ok) {
        if (mutation && result.principal && dependencies.workspaceAuthorization.audit) {
          await dependencies.workspaceAuthorization
            .audit({
              principal: result.principal,
              operationId,
              resourceType: route?.ownerPluginId ?? 'runtime',
              resourceId: routeResourceId(request),
              result: 'denied',
              statusCode: result.status,
              traceId: requestTraceIds.get(request) ?? request.id,
              network: request.ip,
            })
            .catch(() => app.log.error('Identity audit persistence failed'));
        }
        return sendProblem(request, reply, result.status, result.code, result.detail);
      }
      const requiredPermission = route?.requiredPermission;
      workspacePermissions.set(request, result.permissions);
      (
        request as FastifyRequest & { workspacePermissions: readonly string[] }
      ).workspacePermissions = result.permissions;
      if (requiredPermission && !result.permissions.includes(requiredPermission)) {
        if (mutation && dependencies.workspaceAuthorization.audit) {
          await dependencies.workspaceAuthorization
            .audit({
              principal: result.principal,
              operationId,
              resourceType: route?.ownerPluginId ?? 'runtime',
              resourceId: routeResourceId(request),
              result: 'denied',
              statusCode: 403,
              traceId: requestTraceIds.get(request) ?? request.id,
              network: request.ip,
            })
            .catch(() => app.log.error('Identity audit persistence failed'));
        }
        return sendProblem(
          request,
          reply,
          403,
          'FORBIDDEN',
          'You do not have permission to perform this action',
        );
      }
      if (mutation) {
        workspaceAuditStates.set(request, {
          principal: result.principal,
          operationId,
          resourceType: route?.ownerPluginId ?? 'runtime',
          resourceId: routeResourceId(request),
          traceId: requestTraceIds.get(request) ?? request.id,
          network: request.ip,
        });
      }
      if (!acceptingMutations && mutation) {
        return sendProblem(request, reply, 503, 'RUNTIME_UNAVAILABLE', 'Runtime is shutting down');
      }
      (
        request as FastifyRequest & {
          workspacePrincipal: Record<string, unknown>;
        }
      ).workspacePrincipal = result.principal;
      return;
    }
    if (!acceptingMutations && mutation) {
      return sendProblem(request, reply, 503, 'RUNTIME_UNAVAILABLE', 'Runtime is shutting down');
    }
    if (!issuedToken || Date.now() >= tokenExpiresAt || !secureEqual(token, sessionToken)) {
      return sendProblem(request, reply, 401, 'UNAUTHORIZED', 'A Runtime session is required');
    }
  });

  app.setErrorHandler((error, request, reply) => {
    app.log.error({ err: error }, 'unhandled Runtime Gateway error');
    return sendProblem(
      request,
      reply,
      500,
      'INTERNAL_ERROR',
      error instanceof Error ? error.message : 'Unknown Runtime error',
    );
  });
  app.setNotFoundHandler((request, reply) =>
    sendProblem(request, reply, 404, 'NOT_FOUND', 'Route not found'),
  );

  registerPlatformHttp(app, graph, runtimeMetadata, { ...dependencies, realtime }, options, {
    sessionToken,
    validSessionNonces,
    issue() {
      issuedToken = true;
      tokenExpiresAt = Date.now() + 12 * 60 * 60_000;
    },
  });

  const activeGraph: ActiveGraph = await activateGraph(graph, {
    async preflightMigrations(resolved) {
      validateMigrations(resolved, dependencies.migrations);
    },
    async applyMigrations(resolved) {
      await dependencies.platform.initialize(resolved.revision);
      await dependencies.artifactStore.initialize();
      for (const { descriptor } of resolved.plugins) {
        const migration = dependencies.migrations.find(
          ({ pluginId }) => pluginId === descriptor.id,
        );
        if (migration) await migration.migrate();
      }
    },
    async stageContributions() {
      await dependencies.registerPluginHttp(app);
    },
    async validateStaged(resolved) {
      validateRoutes(app, resolved, stagedApiRoutes);
      validateOpenApi(dependencies.openApiDocument, resolved);
    },
  });
  await dependencies.platform.recoverExpiredJobs();
  await dependencies.beforeJobsStart?.();
  dependencies.jobs.start();
  for (const effect of dependencies.effects ?? []) await effect.start();

  app.addHook('preHandler', async (request, reply) => {
    const permissions = workspacePermissions.get(request);
    if (
      permissions &&
      request.method === 'POST' &&
      /^\/api\/v2\/collection-drafts\/[^/]+\/commit(?:\?|$)/.test(request.url) &&
      (request.body as { run?: boolean } | undefined)?.run !== false &&
      !permissions.includes('run.execute')
    )
      return sendProblem(
        request,
        reply,
        403,
        'FORBIDDEN',
        'Running a collection requires run.execute permission',
      );
  });
  app.addHook('onClose', async () => {
    acceptingMutations = false;
    const failures: unknown[] = [];
    for (const action of [
      ...[...(dependencies.effects ?? [])].reverse().map((effect) => () => effect.close()),
      () => dependencies.jobs.close(),
      () => activeGraph.dispose(),
      ...[...dependencies.migrations].reverse().map((migration) => () => migration.close()),
      () => dependencies.artifactStore.close(),
      () => dependencies.platform.close(),
    ]) {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Runtime Gateway cleanup failed');
  });

  return {
    app,
    graph: { profileId: graph.profile.id, revision: graph.revision, pluginIds },
    listen: (listenOptions = {}) =>
      app.listen({ host: listenOptions.host ?? '127.0.0.1', port: listenOptions.port ?? 0 }),
    close: async () => {
      acceptingMutations = false;
      await app.close();
    },
    issueSessionNonce(nonce) {
      if (!nonce.trim()) throw new Error('Session nonce cannot be empty');
      validSessionNonces.add(nonce);
    },
    setAnalyticsWorkerStatus(status) {
      runtimeMetadata.analyticsWorkerStatus = status;
    },
  };
}

interface SessionState {
  sessionToken: string;
  validSessionNonces: Set<string>;
  issue(): void;
}

function registerPlatformHttp(
  app: FastifyInstance,
  graph: ResolvedGraph,
  metadata: RuntimeMetadata,
  dependencies: RuntimeGatewayDependencies,
  options: RuntimeGatewayOptions,
  session: SessionState,
): void {
  app.get('/api/v2/workspace', async () => ({
    workspaceId: await dependencies.platform.getOrCreateWorkspaceId(),
  }));
  app.get('/api/v2/experience/summary', async () =>
    summarizeExperience(await dependencies.platform.listExperienceEvents()),
  );
  app.get('/api/v2/experience/settings', async (_request, reply) => {
    const config = await dependencies.platform.getRuntimeSetting<{
      enabled: boolean;
      revision?: number;
    }>('experience.config');
    const revision = config?.revision ?? 1;
    reply.header('ETag', `"${revision}"`);
    return { enabled: config?.enabled ?? true, retentionDays: 90, revision };
  });
  app.put('/api/v2/experience/settings', async (request, reply) => {
    const body = request.body as { enabled?: unknown };
    if (typeof body?.enabled !== 'boolean' || Object.keys(body).some((k) => k !== 'enabled'))
      return sendProblem(request, reply, 400, 'VALIDATION_ERROR', 'Only enabled is accepted');
    const revision = Number(/^"(\d+)"$/.exec(String(request.headers['if-match']))?.[1]);
    if (!revision)
      return sendProblem(request, reply, 428, 'PRECONDITION_REQUIRED', 'If-Match is required');
    return experienceMutation(dependencies.platform, request, reply, async () => {
      if (
        !(await dependencies.platform.compareRuntimeSetting('experience.config', revision, {
          enabled: body.enabled,
        }))
      )
        return sendProblem(
          request,
          reply,
          412,
          'REVISION_CONFLICT',
          'Settings changed. Reload before editing.',
        );
      reply.header('ETag', `"${revision + 1}"`);
      return { enabled: body.enabled, retentionDays: 90, revision: revision + 1 };
    });
  });
  app.delete('/api/v2/experience/events', async (request, reply) => {
    return experienceMutation(dependencies.platform, request, reply, async () => {
      await dependencies.platform.clearExperienceEvents();
      reply.code(204);
      return null;
    });
  });
  app.post('/api/v2/experience/events', async (request, reply) => {
    const body = request.body as { draftId?: unknown; type?: unknown; eventId?: unknown };
    if (
      !body ||
      body.type !== 'creation_started' ||
      typeof body.draftId !== 'string' ||
      typeof body.eventId !== 'string' ||
      Object.keys(body).some((k) => !['draftId', 'type', 'eventId'].includes(k))
    )
      return sendProblem(
        request,
        reply,
        400,
        'VALIDATION_ERROR',
        'Only draft entry events are accepted; results are confirmed by the server',
      );
    await dependencies.recordExperienceEntry?.(body.draftId);
    reply.code(204);
  });
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_request, reply) => {
    const database = await databaseReadiness(dependencies.platform, graph);
    let infrastructure: RuntimeReadinessProbe;
    try {
      infrastructure = dependencies.readiness
        ? await dependencies.readiness()
        : {
            queue: { status: 'ok', implementation: 'local' },
          };
    } catch {
      infrastructure = {
        queue: { status: 'error' },
      };
    }
    const checks = {
      database,
      queue: infrastructure.queue,
      browser: { status: dependencies.capabilities.browser ? 'ok' : 'unavailable' },
      analyticsWorker: {
        status: metadata.analyticsWorkerStatus === 'ready' ? 'ok' : 'degraded',
        workerStatus: metadata.analyticsWorkerStatus,
      },
    };
    const ready = database.status === 'ok' && infrastructure.queue.status === 'ok';
    reply.code(ready ? 200 : 503);
    return { status: ready ? 'ready' : 'not-ready', checks };
  });
  app.post('/api/v2/session', async (request, reply) => {
    if (dependencies.workspaceAuthorization) {
      return sendProblem(
        request,
        reply,
        410,
        'IDENTITY_AUTH_REQUIRED',
        'Legacy Runtime sessions are disabled; use workspace authentication',
      );
    }
    const body = isObject(request.body) ? request.body : {};
    const nonce = typeof body.nonce === 'string' ? body.nonce : undefined;
    const adminToken = typeof body.adminToken === 'string' ? body.adminToken : undefined;
    const validAdmin = secureEqual(adminToken, options.adminToken);
    const validNonce =
      !options.adminToken && nonce
        ? options.reusableSessionNonce
          ? nonce === options.sessionNonce
          : session.validSessionNonces.has(nonce)
        : false;
    if (!validAdmin && !validNonce) {
      return sendProblem(
        request,
        reply,
        401,
        'UNAUTHORIZED',
        'Runtime session nonce is invalid or expired',
      );
    }
    if (!options.reusableSessionNonce && nonce) session.validSessionNonces.delete(nonce);
    session.issue();
    reply.header('x-runtime-generation', String(metadata.generation));
    return {
      token: session.sessionToken,
      runtime: metadata,
      capabilities: dependencies.capabilities,
    };
  });
  app.get('/api/v2/version', async () => ({
    apiVersion: metadata.apiVersion,
    productVersion: metadata.productVersion,
  }));
  app.get('/api/v2/runtime', async () => metadata);
  app.get('/api/v2/runtime/graph', async () => ({
    profileId: graph.profile.id,
    graphRevision: graph.revision,
    plugins: graph.plugins.map(({ descriptor }) => ({
      id: descriptor.id,
      version: descriptor.version,
      dependencies: descriptor.dependencies?.map(({ id }) => id) ?? [],
    })),
    routes: graph.plugins.flatMap(({ descriptor }) =>
      (descriptor.routes ?? []).map((route) => ({ ...route, ownerPluginId: descriptor.id })),
    ),
    uiContributions: graph.plugins.flatMap(({ descriptor }) =>
      (descriptor.uiContributions ?? []).map((contribution) => ({
        ...contribution,
        ownerPluginId: descriptor.id,
      })),
    ),
  }));
  app.get('/api/v2/capabilities', async () => dependencies.capabilities);
  app.get('/api/v2/runtime/summary', async () => {
    const jobs = await dependencies.jobs.list({ limit: 1_000 });
    const jobsByState = Object.fromEntries(
      [
        'queued',
        'claimed',
        'running',
        'persisting',
        'canceling',
        'canceled',
        'interrupted',
        'succeeded',
        'failed',
      ].map((state) => [state, jobs.filter((job) => job.state === state).length]),
    );
    return {
      schedulingPaused:
        (await dependencies.platform.getRuntimeSetting<boolean>('scheduling.paused')) ?? false,
      startedAt: metadata.startedAt,
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(metadata.startedAt)) / 1_000)),
      queueBacklog: jobs.filter((job) =>
        ['queued', 'claimed', 'running', 'persisting', 'canceling'].includes(job.state),
      ).length,
      jobsByState,
      jobs: jobs.slice(0, 20),
      analyticsWorkerStatus: metadata.analyticsWorkerStatus,
    };
  });
  app.get('/api/v2/desktop/diagnostics', async () => {
    const [jobs, migrations] = await Promise.all([
      dependencies.jobs.list({ limit: 100 }),
      dependencies.platform.listMigrations(),
    ]);
    return {
      runtime: {
        version: metadata.productVersion,
        generation: metadata.generation,
        runtimeId: metadata.runtimeId,
        startedAt: metadata.startedAt,
      },
      browserResources: null,
      database: {
        profileId: metadata.profileId,
        graphRevision: metadata.graphRevision,
        migrationCount: migrations.length,
        jobCount: jobs.length,
      },
    };
  });
  app.post('/api/v2/scheduler/pause', async () => {
    await dependencies.platform.setRuntimeSetting('scheduling.paused', true);
    return { schedulingPaused: true };
  });
  app.post('/api/v2/scheduler/resume', async () => {
    await dependencies.platform.setRuntimeSetting('scheduling.paused', false);
    return { schedulingPaused: false };
  });
  app.get('/api/v2/openapi.json', async () => dependencies.openApiDocument);
  app.get('/api/v2/events/domain', async (request, reply) => {
    const after = Number((request.query as { after?: string }).after ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) {
      return sendProblem(request, reply, 400, 'VALIDATION_ERROR', 'after must be non-negative');
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...sseCorsHeaders(request, options.allowedOrigins),
    });
    let cursor = after;
    let flushing = false;
    const flush = async () => {
      if (flushing) return;
      flushing = true;
      try {
        for (const event of await dependencies.platform.listEvents(cursor, 100)) {
          cursor = event.cursor;
          reply.raw.write(
            `id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          );
        }
      } finally {
        flushing = false;
      }
    };
    await flush();
    const timer = setInterval(() => void flush(), 500);
    timer.unref?.();
    request.raw.once('close', () => clearInterval(timer));
  });
  app.get('/api/v2/events/realtime', async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...sseCorsHeaders(request, options.allowedOrigins),
    });
    const canStream = async () => {
      if (!dependencies.workspaceAuthorization) return true;
      const auth = await dependencies.workspaceAuthorization.authenticate({
        sessionToken: requestCookie(
          request,
          dependencies.workspaceAuthorization.sessionCookieName ?? 'zhiyun_session',
        ),
        csrfToken: undefined,
        mutation: false,
      });
      return auth.ok && auth.permissions.includes('workspace.read');
    };
    let writes = Promise.resolve();
    const unsubscribe = dependencies.realtime?.subscribe((event) => {
      const audience = event.payload.audienceUserId;
      const userId =
        (request as FastifyRequest & { workspacePrincipal?: { userId?: string } })
          .workspacePrincipal?.userId ?? 'local-workspace';
      if (typeof audience === 'string' && audience !== userId) return;
      writes = writes
        .then(async () => {
          if (reply.raw.destroyed || reply.raw.writableEnded) return;
          if (!(await canStream())) {
            reply.raw.end();
            return;
          }
          reply.raw.write(
            `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          );
        })
        .catch(() => {
          reply.raw.end();
        });
    });
    const heartbeat = setInterval(() => {
      void canStream()
        .then((allowed) => {
          if (!allowed) reply.raw.end();
          else if (!reply.raw.writableEnded) reply.raw.write(': heartbeat\n\n');
        })
        .catch(() => reply.raw.end());
    }, 15_000);
    heartbeat.unref?.();
    request.raw.once('close', () => {
      clearInterval(heartbeat);
      unsubscribe?.();
    });
  });
  app.get('/api/v2/artifacts/:artifactId/content', async (request, reply) => {
    const artifactId = (request.params as { artifactId?: string }).artifactId;
    const artifact = artifactId ? await dependencies.platform.getArtifact(artifactId) : null;
    if (!artifact) return sendProblem(request, reply, 404, 'NOT_FOUND', 'Artifact was not found');
    const path = await dependencies.artifactStore.resolveArtifact(artifact.storageKey);
    reply.type(artifact.contentType).header('content-disposition', attachment(artifact.filename));
    return reply.send(createReadStream(path));
  });
  app.post('/api/v2/artifacts/:artifactId/save', async (request, reply) => {
    if (!dependencies.saveArtifact) {
      return sendProblem(request, reply, 409, 'CAPABILITY_UNAVAILABLE', 'Host save is unavailable');
    }
    const artifactId = (request.params as { artifactId?: string }).artifactId;
    const artifact = artifactId ? await dependencies.platform.getArtifact(artifactId) : null;
    if (!artifact) return sendProblem(request, reply, 404, 'NOT_FOUND', 'Artifact was not found');
    return dependencies.saveArtifact(artifact);
  });
}

function validateMigrations(graph: ResolvedGraph, migrations: readonly RuntimeMigration[]): void {
  const duplicate = migrations.find(
    (candidate, index) =>
      migrations.findIndex(({ pluginId }) => pluginId === candidate.pluginId) !== index,
  );
  if (duplicate) throw new Error(`Duplicate Runtime migration provider ${duplicate.pluginId}`);
  for (const { descriptor } of graph.plugins) {
    if (
      (descriptor.migrations?.length ?? 0) > 0 &&
      !migrations.some(({ pluginId }) => pluginId === descriptor.id)
    ) {
      throw new Error(`Plugin ${descriptor.id} has no Runtime migration provider`);
    }
  }
}

async function databaseReadiness(
  platform: PlatformRepository,
  graph: ResolvedGraph,
): Promise<
  | { status: 'ok'; migrationCount: number }
  | { status: 'error'; migrationCount: number; missingMigrations: string[] }
> {
  try {
    const migrations = await platform.listMigrations();
    const succeeded = new Set(
      migrations
        .filter(({ result }) => result === 'succeeded')
        .map(({ pluginId, migrationId }) => `${pluginId}:${migrationId}`),
    );
    const expected = graph.plugins.flatMap(({ descriptor }) =>
      (descriptor.migrations ?? []).map(({ id }) => `${descriptor.id}:${id}`),
    );
    const missingMigrations = expected.filter((id) => !succeeded.has(id));
    return missingMigrations.length === 0
      ? { status: 'ok', migrationCount: migrations.length }
      : { status: 'error', migrationCount: migrations.length, missingMigrations };
  } catch {
    return { status: 'error', migrationCount: 0, missingMigrations: ['database-unreachable'] };
  }
}

function validateRoutes(
  app: FastifyInstance,
  graph: ResolvedGraph,
  stagedApiRoutes: ReadonlySet<string>,
): void {
  const expectedApiRoutes = new Set<string>();
  for (const { descriptor } of graph.plugins) {
    for (const route of descriptor.routes ?? []) {
      if (!app.hasRoute({ method: route.method, url: fastifyPath(route) })) {
        throw new Error(
          `Plugin ${descriptor.id} did not stage ${route.method.toUpperCase()} ${route.path}`,
        );
      }
      if (route.path.startsWith('/api/')) {
        expectedApiRoutes.add(`${route.method.toUpperCase()} ${fastifyPath(route)}`);
      }
    }
  }
  for (const route of stagedApiRoutes) {
    if (!expectedApiRoutes.has(route)) {
      throw new Error(`Runtime staged an unowned API route without requiredPermission: ${route}`);
    }
  }
}

function validateOpenApi(document: unknown, graph: ResolvedGraph): void {
  if (!isObject(document) || !isObject(document.paths)) {
    throw new Error('Product OpenAPI document does not contain paths');
  }
  const expected = new Map<string, string>();
  for (const { descriptor } of graph.plugins) {
    for (const route of descriptor.routes ?? []) {
      expected.set(`${route.method.toLowerCase()} ${route.path}`, route.operationId);
    }
  }
  const actual = new Map<string, string>();
  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (!isObject(pathItem)) continue;
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const operation = pathItem[method];
      if (isObject(operation) && typeof operation.operationId === 'string') {
        actual.set(`${method} ${path}`, operation.operationId);
      }
    }
  }
  for (const [route, operationId] of expected) {
    if (actual.get(route) !== operationId) {
      throw new Error(`Product OpenAPI mismatch for ${route}: expected ${operationId}`);
    }
  }
  for (const route of actual.keys()) {
    if (!expected.has(route)) throw new Error(`Product OpenAPI exposes unowned route ${route}`);
  }
}

function fastifyPath(route: RouteContribution): string {
  return route.path.replaceAll(/\{([^}]+)\}/g, ':$1');
}

interface RouteMetadata {
  readonly operationId: string;
  readonly ownerPluginId: string;
  readonly requiredPermission: string | null;
}

function routeMetadata(request: FastifyRequest, graph: ResolvedGraph): RouteMetadata | undefined {
  const method = request.method.toUpperCase();
  const path = request.routeOptions.url || request.url.split('?')[0];
  for (const { descriptor } of graph.plugins) {
    const route = descriptor.routes?.find(
      (candidate) =>
        (candidate.method.toUpperCase() === method ||
          (method === 'HEAD' && candidate.method.toUpperCase() === 'GET')) &&
        fastifyPath(candidate) === path,
    );
    if (route) {
      return {
        operationId: route.operationId,
        ownerPluginId: descriptor.id,
        requiredPermission: route.requiredPermission,
      };
    }
  }
  return undefined;
}

function routeResourceId(request: FastifyRequest): string | null {
  if (!isObject(request.params)) return null;
  const clues = Object.entries(request.params)
    .filter(
      ([key, value]) =>
        // Route parameters ending in Id/Key identify the audited resource; they are opaque
        // identifiers, not the corresponding credential value (for example tokenId).
        typeof value === 'string' && /(?:Id|Key)$/u.test(key),
    )
    .map(([key, value]) => `${key}=${String(value).slice(0, 200)}`);
  return clues.length > 0 ? clues.join(',').slice(0, 1_000) : null;
}

function auditResult(statusCode: number): 'succeeded' | 'failed' | 'denied' {
  if (statusCode === 401 || statusCode === 403) return 'denied';
  return statusCode < 400 ? 'succeeded' : 'failed';
}

function requestCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function incomingTraceId(request: FastifyRequest): string {
  const traceparent = request.headers.traceparent;
  const match =
    typeof traceparent === 'string'
      ? /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i.exec(traceparent)
      : null;
  return match?.[1]?.toLowerCase() ?? request.id;
}

function validTraceId(value: string): boolean {
  return /^[\da-f]{32}$/i.test(value) && value !== '00000000000000000000000000000000';
}

function bearerToken(value: string | undefined): string | undefined {
  return value?.startsWith('Bearer ') ? value.slice(7) : undefined;
}

function sseCorsHeaders(
  request: FastifyRequest,
  allowedOrigins: readonly string[],
): Record<string, string> {
  const origin = request.headers.origin;
  return typeof origin === 'string' && allowedOrigins.includes(origin)
    ? { 'access-control-allow-origin': origin, vary: 'Origin' }
    : {};
}

function secureEqual(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  detail: string,
) {
  return reply
    .code(status)
    .type('application/problem+json')
    .send({
      type: `https://zhiyun.dev/problems/${code.toLowerCase().replaceAll('_', '-')}`,
      title: code,
      status,
      code,
      detail: redactSensitiveText(detail),
      instance: redactSensitiveUrl(request.url),
      traceId: requestTraceIds.get(request) ?? request.id,
    });
}

const sensitiveName = /token|key|secret|password|passwd|auth|cookie|signature|session|invitation/i;

export function redactSensitiveUrl(value: string): string {
  try {
    const parsed = new URL(value, 'http://zhiyun.invalid');
    parsed.username = '';
    parsed.password = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (sensitiveName.test(key)) parsed.searchParams.set(key, '[REDACTED]');
    }
    if (parsed.hash) {
      const fragment = new URLSearchParams(parsed.hash.slice(1));
      for (const key of [...fragment.keys()]) {
        if (sensitiveName.test(key)) fragment.set(key, '[REDACTED]');
      }
      parsed.hash = fragment.toString();
    }
    return parsed.origin === 'http://zhiyun.invalid'
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : parsed.toString();
  } catch {
    return '[invalid-url]';
  }
}

const requiredLogRedactions = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
] as const;

/** Applies mandatory request sanitization to every enabled Fastify/Pino logger. */
export function secureRuntimeLogger(
  logger: boolean | Record<string, unknown>,
): boolean | Record<string, unknown> {
  if (logger === false) return false;
  const configured = logger === true ? {} : logger;
  const serializers = isObject(configured.serializers) ? configured.serializers : {};
  const hooks = isObject(configured.hooks) ? configured.hooks : {};
  return {
    ...configured,
    redact: mergeLogRedactions(configured.redact),
    serializers: {
      ...serializers,
      req: serializeRuntimeRequest,
    },
    hooks: {
      ...hooks,
      logMethod(
        this: unknown,
        inputArguments: unknown[],
        method: (...arguments_: unknown[]) => void,
      ) {
        method.apply(this, inputArguments.map(sanitizeLogArgument));
      },
    },
  };
}

export function serializeRuntimeRequest(request: Record<string, unknown>): Record<string, unknown> {
  const socket = isObject(request.socket) ? request.socket : {};
  const url = typeof request.url === 'string' ? redactSensitiveUrl(request.url) : undefined;
  return {
    ...(typeof request.id === 'string' ? { id: request.id } : {}),
    ...(typeof request.method === 'string' ? { method: request.method } : {}),
    ...(url ? { url } : {}),
    ...(typeof request.hostname === 'string' ? { hostname: request.hostname } : {}),
    ...(typeof request.remoteAddress === 'string'
      ? { remoteAddress: request.remoteAddress }
      : typeof socket.remoteAddress === 'string'
        ? { remoteAddress: socket.remoteAddress }
        : {}),
    ...(typeof request.remotePort === 'number'
      ? { remotePort: request.remotePort }
      : typeof socket.remotePort === 'number'
        ? { remotePort: socket.remotePort }
        : {}),
  };
}

function mergeLogRedactions(configured: unknown): unknown {
  if (Array.isArray(configured)) {
    return [
      ...new Set([
        ...configured.filter((path): path is string => typeof path === 'string'),
        ...requiredLogRedactions,
      ]),
    ];
  }
  if (isObject(configured)) {
    const paths = Array.isArray(configured.paths)
      ? configured.paths.filter((path): path is string => typeof path === 'string')
      : [];
    return { ...configured, paths: [...new Set([...paths, ...requiredLogRedactions])] };
  }
  return [...requiredLogRedactions];
}

function redactSensitiveText(value: string): string {
  return value
    .replaceAll(/https?:\/\/[^\s"'<>]+/gi, (url) => redactSensitiveUrl(url))
    .replaceAll(
      /([?&#](?:token|key|secret|password|passwd|auth|cookie|signature|session|invitation)[^=&#\s]*=)[^&#\s]*/gi,
      '$1[REDACTED]',
    )
    .replaceAll(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replaceAll(
      /((?:authorization|cookie|proxy-authorization|api[-_ ]?key)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[REDACTED]',
    )
    .replaceAll(/(postgres(?:ql)?:\/\/)[^\s@]+@/gi, '$1[REDACTED]@');
}

function sanitizeLogArgument(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (value instanceof Error) {
    const error = new Error(redactSensitiveText(value.message), {
      ...(value.cause === undefined ? {} : { cause: sanitizeLogArgument(value.cause) }),
    });
    error.name = value.name;
    if (value.stack) error.stack = redactSensitiveText(value.stack);
    return error;
  }
  return value;
}

function attachment(filename: string): string {
  const safe = filename.replaceAll(/["\\\r\n]/g, '_');
  return `attachment; filename="${safe}"`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

async function experienceMutation(
  platform: PlatformRepository,
  request: FastifyRequest,
  reply: FastifyReply,
  operation: () => Promise<unknown>,
) {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || !key || key.length > 200)
    return sendProblem(request, reply, 428, 'PRECONDITION_REQUIRED', 'Idempotency-Key is required');
  const scope = `platform:${request.method}:${request.routeOptions.url}`;
  const requestHash = createHash('sha256')
    .update(
      JSON.stringify({ body: request.body ?? null, revision: request.headers['if-match'] ?? null }),
    )
    .digest('hex');
  const reservation = await platform.reserveIdempotency({
    scope,
    key,
    requestHash,
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
  });
  if (reservation.state === 'completed') {
    reply.code(reservation.responseStatus);
    const revision = (reservation.responseBody as { revision?: number } | null)?.revision;
    if (revision) reply.header('ETag', `"${revision}"`);
    return reservation.responseBody;
  }
  if (reservation.state !== 'reserved')
    return sendProblem(
      request,
      reply,
      409,
      'IDEMPOTENCY_CONFLICT',
      'This operation conflicts with an earlier request',
    );
  try {
    const response = await operation();
    if (reply.statusCode >= 400) {
      await platform.releaseIdempotency({ scope, key, requestHash });
      return response;
    }
    await platform.completeIdempotency({
      scope,
      key,
      requestHash,
      responseStatus: reply.statusCode,
      responseBody: response,
    });
    return response;
  } catch (error) {
    await platform.releaseIdempotency({ scope, key, requestHash });
    throw error;
  }
}
