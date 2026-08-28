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

export interface RuntimeMigration {
  pluginId: string;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export interface RuntimeGatewayDependencies {
  platform: PlatformRepository;
  artifactStore: ArtifactStore;
  jobs: PlatformJobQueue;
  migrations: readonly RuntimeMigration[];
  registerPluginHttp(app: FastifyInstance): Promise<void>;
  metadata: Omit<
    RuntimeMetadata,
    'profileId' | 'graphRevision' | 'enabledPluginIds' | 'enabledUiContributionIds'
  >;
  capabilities: RuntimeCapabilities;
  openApiDocument: unknown;
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
  const app = Fastify({ logger: options.logger ?? false, trustProxy: options.trustProxy ?? false });
  const tracer = trace.getTracer('zhiyun.runtime-gateway', dependencies.metadata.productVersion);
  const requestSpans = new WeakMap<FastifyRequest, Span>();
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
    credentials: false,
    allowedHeaders: [
      'authorization',
      'content-type',
      'idempotency-key',
      'if-match',
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
    const span = requestSpans.get(request);
    if (!span) return;
    span.setAttribute('http.response.status_code', reply.statusCode);
    span.setStatus({
      code: reply.statusCode >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK,
    });
    span.end();
  });

  app.addHook('onRequest', async (request, reply) => {
    if (isPublicRoute(request)) return;
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
    if (!issuedToken || Date.now() >= tokenExpiresAt || !secureEqual(token, sessionToken)) {
      return sendProblem(request, reply, 401, 'UNAUTHORIZED', 'A Runtime session is required');
    }
    if (!acceptingMutations && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
      return sendProblem(request, reply, 503, 'RUNTIME_UNAVAILABLE', 'Runtime is shutting down');
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

  registerPlatformHttp(app, graph, runtimeMetadata, dependencies, options, {
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
      validateRoutes(app, resolved);
      validateOpenApi(dependencies.openApiDocument, resolved);
    },
  });
  await dependencies.platform.recoverExpiredJobs();
  dependencies.jobs.start();
  for (const effect of dependencies.effects ?? []) await effect.start();

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
  app.get('/health', async () => ({
    status: 'ok',
    services: {
      database: 'ok',
      jobs: 'ok',
      analyticsWorker: metadata.analyticsWorkerStatus,
    },
  }));
  app.post('/api/v2/session', async (request, reply) => {
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
  app.get('/api/v2/runtime/summary', async () => ({
    schedulingPaused:
      (await dependencies.platform.getRuntimeSetting<boolean>('scheduling.paused')) ?? false,
    jobs: await dependencies.jobs.list({ limit: 20 }),
    analyticsWorkerStatus: metadata.analyticsWorkerStatus,
  }));
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
      ...sseCorsHeaders(request, options.allowedOrigins),
    });
    const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
    heartbeat.unref?.();
    request.raw.once('close', () => clearInterval(heartbeat));
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

function validateRoutes(app: FastifyInstance, graph: ResolvedGraph): void {
  for (const { descriptor } of graph.plugins) {
    for (const route of descriptor.routes ?? []) {
      if (!app.hasRoute({ method: route.method, url: fastifyPath(route) })) {
        throw new Error(
          `Plugin ${descriptor.id} did not stage ${route.method.toUpperCase()} ${route.path}`,
        );
      }
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

function isPublicRoute(request: FastifyRequest): boolean {
  return (
    request.method === 'OPTIONS' ||
    request.url === '/health' ||
    request.url.startsWith('/api/v2/session') ||
    request.url.startsWith('/api/v2/openapi.json') ||
    request.url === '/api/v2/version' ||
    request.url === '/api/v2/runtime' ||
    request.url === '/api/v2/runtime/graph' ||
    request.url === '/api/v2/capabilities' ||
    request.url === '/api/tasks' ||
    request.url.startsWith('/api/v1/')
  );
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

const sensitiveName = /token|key|secret|password|passwd|auth|cookie|signature|session/i;

function redactSensitiveUrl(value: string): string {
  try {
    const parsed = new URL(value, 'http://zhiyun.invalid');
    parsed.username = '';
    parsed.password = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (sensitiveName.test(key)) parsed.searchParams.set(key, '[REDACTED]');
    }
    return parsed.origin === 'http://zhiyun.invalid'
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : parsed.toString();
  } catch {
    return '[invalid-url]';
  }
}

function redactSensitiveText(value: string): string {
  return value
    .replaceAll(/https?:\/\/[^\s"'<>]+/gi, (url) => redactSensitiveUrl(url))
    .replaceAll(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replaceAll(
      /((?:authorization|cookie|proxy-authorization|api[-_ ]?key)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[REDACTED]',
    )
    .replaceAll(/(postgres(?:ql)?:\/\/)[^\s@]+@/gi, '$1[REDACTED]@');
}

function attachment(filename: string): string {
  const safe = filename.replaceAll(/["\\\r\n]/g, '_');
  return `attachment; filename="${safe}"`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
