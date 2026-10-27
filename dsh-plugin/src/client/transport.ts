import type { ApiResult, EventFrame, InvokeInput, Json, RuntimeReady } from '../shared/protocol.js';
export interface RemoteApi {
  status(workspaceId: string): Promise<{ generation: number; routes: RuntimeReady['routes'] }>;
  invoke(input: InvokeInput, signal?: AbortSignal): Promise<ApiResult>;
  events(
    workspaceId: string,
    channel: 'domain' | 'realtime',
    after: number,
    signal?: AbortSignal,
  ): AsyncIterable<EventFrame>;
  readArtifact(
    workspaceId: string,
    artifactId: string,
    signal?: AbortSignal,
  ): AsyncIterable<{ data: string }>;
  saveArtifact(
    workspaceId: string,
    artifactId: string,
    filename: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
}
export function productTransport(remote: RemoteApi, workspaceId: string, nativeSave = false) {
  let routes: RuntimeReady['routes'] | undefined;
  return {
    async fetch(path: string, init: RequestInit = {}): Promise<Response> {
      const url = new URL(path, 'https://zhiyun.invalid');
      const signal = init.signal ?? undefined;
      const event = /^\/api\/v2\/events\/(domain|realtime)$/.exec(url.pathname);
      if (event) {
        const source = remote.events(
          workspaceId,
          event[1] as 'domain' | 'realtime',
          Number(url.searchParams.get('after') ?? 0),
          signal,
        );
        const iterator = source[Symbol.asyncIterator]();
        return new Response(
          new ReadableStream({
            async pull(controller) {
              try {
                const next = await iterator.next();
                if (next.done) controller.close();
                else
                  controller.enqueue(
                    new TextEncoder().encode(`data: ${JSON.stringify(next.value.data)}\n\n`),
                  );
              } catch (error) {
                controller.error(error);
              }
            },
            async cancel() {
              await iterator.return?.();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      const artifact = /^\/api\/v2\/artifacts\/([^/]+)\/content$/.exec(url.pathname);
      if (artifact) {
        const source = remote.readArtifact(workspaceId, artifact[1]!, signal);
        const iterator = source[Symbol.asyncIterator]();
        return new Response(
          new ReadableStream({
            async pull(controller) {
              try {
                const next = await iterator.next();
                if (next.done) controller.close();
                else
                  controller.enqueue(
                    Uint8Array.from(atob(next.value.data), (value) => value.charCodeAt(0)),
                  );
              } catch (error) {
                controller.error(error);
              }
            },
            async cancel() {
              await iterator.return?.();
            },
          }),
        );
      }
      routes ??= (await remote.status(workspaceId)).routes;
      const method = (init.method ?? 'GET').toUpperCase();
      let parameters: Record<string, string> = {};
      const route = routes.find((route) => {
        if (route.method !== method) return false;
        const names: string[] = [];
        const pattern = route.path
          .replace(/[.*+?^$()|[\]\\]/g, '\\$&')
          .replace(/\{([^}]+)\}/g, (_, name: string) => {
            names.push(name);
            return '([^/]+)';
          });
        const match = new RegExp(`^${pattern}$`).exec(url.pathname);
        if (!match) return false;
        parameters = Object.fromEntries(
          names.map((name, i) => [name, decodeURIComponent(match[i + 1]!)]),
        );
        return true;
      });
      if (!route)
        throw new Error(
          `This operation is not available in the DSH edition: ${method} ${url.pathname}`,
        );
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, name) => {
        if (['if-match', 'idempotency-key', 'if-none-match'].includes(name)) headers[name] = value;
      });
      const result = await remote.invoke(
        {
          workspaceId,
          operationId: route.operationId,
          path: parameters,
          query: Object.fromEntries(url.searchParams),
          headers,
          ...(init.body ? { body: JSON.parse(String(init.body)) as Json } : {}),
        },
        signal,
      );
      return new Response([204, 304].includes(result.status) ? null : JSON.stringify(result.body), {
        status: result.status,
        headers: { ...result.headers, 'content-type': 'application/json' },
      });
    },
    ...(nativeSave
      ? {
          async saveArtifact(artifact: { id: string; filename: string }) {
            await remote.saveArtifact(workspaceId, artifact.id, artifact.filename);
          },
        }
      : {}),
  };
}
