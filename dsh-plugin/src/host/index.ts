import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type {} from '@deepseek-ai/dsh-credentials';
import { credentialKey } from '@deepseek-ai/dsh-credentials';
import type {} from '@deepseek-ai/dsh-workspace';
import type {} from '@deepseek-ai/dsh-agent-default-model';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-app-boot';
import type {} from '@deepseek-ai/dsh-host-directory-picker';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, rename, rm } from 'node:fs/promises';
import { RuntimeProcess } from './runtime-process.js';
import { allowedRoute, apiRequest, containedFile } from './policy.js';
import { registerTools } from './tools.js';
import type {
  ApiResult,
  EventFrame,
  InvokeInput,
  Json,
  ModelSelection,
  RuntimeReady,
  RuntimeStatus,
} from '../shared/protocol.js';

export interface Config {
  dataDirectory?: string;
  resources?: string;
}
interface WorkspaceRuntime {
  process: RuntimeProcess;
  directory: string;
  model: ModelSelection | null;
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    zhiyun: ZhiYunService;
  }
}

/** Owns one private business runtime per DSH workspace. No business credentials cross the Remote wire. */
export class ZhiYunService extends TypertRemoteService {
  static inject = [
    'llm',
    'credentials',
    'workspaceRegistry',
    'typert',
    'tools',
    'jobs',
    'agentDefaultModel',
  ];
  static Config = Schema.object({ dataDirectory: Schema.string(), resources: Schema.string() });
  private runtimes = new Map<string, WorkspaceRuntime>();
  private exportDirectories = new Map<string, string>();
  private lifetime = new AbortController();
  private generation = 0;
  private prompts = new Map<
    string,
    {
      workspaceId: string;
      kind: string;
      resolve(value: { reference: string } | { canceled: true }): void;
    }
  >();
  constructor(
    ctx: Context,
    private config: Config = {},
  ) {
    super(ctx, 'zhiyun');
    ctx.effect(() => () => this.close(), 'zhiyun: runtime ownership');
    registerTools(ctx, this);
    ctx.effect(() => {
      const timer = setInterval(() => {
        const model = this.defaultModel();
        for (const entry of this.runtimes.values()) entry.process.setDefaultModel(model);
      }, 1000);
      timer.unref();
      return () => clearInterval(timer);
    }, 'zhiyun: follow DSH default model');
  }
  private owner(): void {
    if (this.ctx.invocation && this.ctx.invocation.peer.principal.kind !== 'owner')
      throw new Error('ZhiYun is available only to the local owner');
  }
  private defaultModel(): ModelSelection | null {
    return this.ctx.agentDefaultModel?.currentSelection() ?? null;
  }
  private workspace(workspaceId: string) {
    const workspace = this.ctx.workspaceRegistry.list().find((value) => value.id === workspaceId);
    if (!workspace) throw new Error('Unknown DSH workspace');
    return workspace;
  }
  private getRuntime(workspaceId: string): WorkspaceRuntime {
    this.workspace(workspaceId);
    this.lifetime.signal.throwIfAborted();
    let entry = this.runtimes.get(workspaceId);
    if (!entry) {
      const workspace = this.workspace(workspaceId);
      const profile = createHash('sha256')
        .update(this.ctx.get('profileContext')?.dir ?? 'default')
        .digest('hex')
        .slice(0, 16);
      const directory = join(
        this.config.dataDirectory ?? join(resolveDshHome(), 'zhiyun'),
        profile,
        workspaceId,
      );
      const resources =
        this.config.resources ?? join(dirname(fileURLToPath(import.meta.url)), '../resources');
      const model = this.defaultModel();
      entry = {
        directory: workspace.path,
        model,
        process: new RuntimeProcess(
          {
            dataDirectory: directory,
            workspaceDirectory: workspace.path,
            resources,
            generation: ++this.generation,
            model,
          },
          (method, value, signal) => this.hostCall(workspaceId, method, value, signal),
        ),
      };
      this.runtimes.set(workspaceId, entry);
    }
    return entry;
  }
  /** List workspace identities from the Host registry; filesystem paths are not accepted from callers. */
  @Remote
  workspaces(): Array<{ id: string; name: string }> {
    this.owner();
    return this.ctx.workspaceRegistry
      .list()
      .map((workspace) => ({ id: workspace.id, name: workspace.title }));
  }
  /** Inspect the isolated runtime, model choice, and active business operations. */
  @Remote
  async status(workspaceId: string): Promise<RuntimeStatus & { routes: RuntimeReady['routes'] }> {
    this.owner();
    const entry = this.getRuntime(workspaceId);
    const ready = await entry.process.start();
    const response = await fetch(`${ready.url}/api/v2/runtime`, {
      headers: { authorization: `Bearer ${ready.token}` },
      signal: this.lifetime.signal,
    });
    const metadata = (await response.json()) as {
      analyticsWorkerStatus?: string;
      runtime?: { analyticsWorkerStatus?: string };
    };
    const worker =
      metadata.analyticsWorkerStatus ?? metadata.runtime?.analyticsWorkerStatus ?? 'unavailable';
    return {
      workspaceId,
      status: worker === 'ready' ? 'ready' : 'degraded',
      worker,
      generation: ready.generation,
      model: this.defaultModel(),
      routes: ready.routes.filter(allowedRoute),
    };
  }
  /** Invoke one catalogued operation with the original business validation, ETags and idempotency semantics. */
  @Remote
  async invoke(input: InvokeInput, signal: AbortSignal): Promise<ApiResult> {
    this.owner();
    return this.invokeFor(input, this.defaultModel(), signal);
  }
  async invokeFor(
    input: InvokeInput,
    model: ModelSelection | null,
    signal: AbortSignal,
  ): Promise<ApiResult> {
    const entry = this.getRuntime(input.workspaceId);
    const ready = await entry.process.start();
    const request = apiRequest(ready.routes, input);
    const headers = {
      ...request.headers,
      authorization: `Bearer ${ready.token}`,
      ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
      'x-zhiyun-model': Buffer.from(JSON.stringify(model)).toString('base64url'),
    };
    const response = await fetch(`${ready.url}${request.path}`, {
      method: request.method,
      headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: AbortSignal.any([signal, this.lifetime.signal]),
    });
    const body = [204, 304].includes(response.status) ? null : ((await response.json()) as Json);
    const safeHeaders: Record<string, string> = {};
    for (const name of ['etag', 'x-trace-id', 'x-runtime-generation']) {
      const value = response.headers.get(name);
      if (value) safeHeaders[name] = value;
    }
    return { status: response.status, headers: safeHeaders, body };
  }
  async describeOperation(
    workspaceId: string,
    operationId: string,
    signal: AbortSignal,
  ): Promise<Json> {
    this.owner();
    const ready = await this.getRuntime(workspaceId).process.start();
    const route = ready.routes.find(
      (route) => route.operationId === operationId && allowedRoute(route),
    );
    if (!route) throw new Error('Unsupported business operation');
    const response = await this.invokeFor(
      { workspaceId, operationId: 'getProductOpenApi' },
      this.defaultModel(),
      signal,
    );
    const document = response.body as {
      paths?: Record<string, Record<string, Json>>;
      components?: { schemas?: Record<string, Json> };
    };
    const operation = document.paths?.[route.path]?.[route.method.toLowerCase()];
    if (!operation) throw new Error('Operation schema unavailable');
    const schemas: Record<string, Json> = {};
    const visit = (value: Json): void => {
      if (!value || typeof value !== 'object') return;
      if (
        !Array.isArray(value) &&
        typeof value.$ref === 'string' &&
        value.$ref.startsWith('#/components/schemas/')
      ) {
        const key = value.$ref.slice('#/components/schemas/'.length);
        if (!(key in schemas) && document.components?.schemas?.[key]) {
          if (Object.keys(schemas).length >= 128) throw new Error('Schema exceeds preview limit');
          schemas[key] = document.components.schemas[key]!;
          visit(schemas[key]!);
        }
      }
      for (const child of Object.values(value)) visit(child);
    };
    visit(operation);
    const result: Json = {
      operationId,
      method: route.method,
      path: route.path,
      operation,
      components: { schemas },
    };
    if (Buffer.byteLength(JSON.stringify(result)) > 262144)
      throw new Error('Schema exceeds preview limit');
    return result;
  }
  /** Follow persistent domain events or transient progress; the caller supplies a durable cursor after reconnecting. */
  @Remote({ mode: 'stream' })
  async *events(
    workspaceId: string,
    channel: 'domain' | 'realtime',
    after: number,
    signal: AbortSignal,
  ): AsyncIterable<EventFrame> {
    this.owner();
    const ready = await this.getRuntime(workspaceId).process.start();
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid event cursor');
    const response = await fetch(`${ready.url}/api/v2/events/${channel}?after=${after}`, {
      headers: { authorization: `Bearer ${ready.token}` },
      signal: AbortSignal.any([signal, this.lifetime.signal]),
    });
    if (!response.ok || !response.body) throw new Error('Event stream unavailable');
    let buffer = '';
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      buffer += chunk;
      if (buffer.length > 1_048_576) throw new Error('Event frame too large');
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (data) yield { channel, data: JSON.parse(data) as Json };
      }
    }
  }
  /** Write a user-supplied secret into the Host credential provider and return only its reference. */
  @Remote
  async setCredential(
    workspaceId: string,
    kind: string,
    value: Json,
  ): Promise<{ reference: string }> {
    this.owner();
    this.workspace(workspaceId);
    if (
      !/^(task-secret-headers|task-cookies|task-proxy|task-browser-session|output-webhook|output-google-sheets|output-s3|output-directory)$/.test(
        kind,
      )
    )
      throw new Error('Unsupported credential kind');
    if (
      kind === 'output-directory' &&
      (!value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        value.path !== (await this.exportRoot(workspaceId)))
    )
      throw new Error('Choose the export directory through the Host directory picker');
    const reference = `${kind}-${randomUUID()}`;
    await this.writeCredential(workspaceId, reference, value);
    return { reference };
  }
  /** List pending manual credential requests without exposing values. */
  @Remote
  credentialPrompts(workspaceId: string): Array<{ id: string; kind: string }> {
    this.owner();
    this.workspace(workspaceId);
    return [...this.prompts]
      .filter(([, prompt]) => prompt.workspaceId === workspaceId)
      .map(([id, prompt]) => ({ id, kind: prompt.kind }));
  }
  /** Answer a manual credential prompt; secret input goes straight to the Host credential provider. */
  @Remote
  async answerCredentialPrompt(
    workspaceId: string,
    id: string,
    value: Json,
    canceled: boolean,
  ): Promise<void> {
    this.owner();
    const prompt = this.prompts.get(id);
    if (!prompt || prompt.workspaceId !== workspaceId) throw new Error('Credential prompt expired');
    const result = canceled
      ? { canceled: true as const }
      : await this.setCredential(workspaceId, prompt.kind, value);
    this.prompts.delete(id);
    prompt.resolve(result);
  }
  private key(workspaceId: string, reference: string) {
    if (!/^[a-z][a-z0-9-]{1,150}$/.test(reference)) throw new Error('Invalid credential reference');
    return credentialKey(
      'zhiyun',
      `w${createHash('sha256').update(workspaceId).digest('hex').slice(0, 16)}-${reference}`,
    );
  }
  private async writeCredential(workspaceId: string, reference: string, value: unknown) {
    await this.ctx.credentials.modifyRecord(this.key(workspaceId, reference), async () => ({
      kind: 'grant',
      payload: value,
    }));
  }
  /** Choose an export directory through the Host's trusted native picker. Cancellation preserves the current destination. */
  @Remote
  async selectExportDirectory(
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<{ selected: boolean }> {
    this.owner();
    this.workspace(workspaceId);
    const capability = this.ctx.get('directoryPicker')?.capability();
    if (capability?.kind !== 'native') return { selected: false };
    const path = await capability.pick(signal);
    if (path) {
      this.exportDirectories.set(workspaceId, path);
      await this.writeCredential(workspaceId, 'output-directory-selected', { path });
    }
    return { selected: Boolean(path) };
  }
  private async exportRoot(workspaceId: string): Promise<string> {
    const cached = this.exportDirectories.get(workspaceId);
    if (cached) return cached;
    const record = await this.ctx.credentials.readRecord(
      this.key(workspaceId, 'output-directory-selected'),
    );
    if (
      record?.kind === 'grant' &&
      typeof (record.payload as { path?: unknown })?.path === 'string'
    )
      return (record.payload as { path: string }).path;
    return join(this.workspace(workspaceId).path, 'exports/zhiyun');
  }
  /** Read an Artifact as bounded base64 chunks; arbitrary storage keys and paths are never accepted. */
  @Remote({ mode: 'stream' })
  async *readArtifact(
    workspaceId: string,
    artifactId: string,
    signal: AbortSignal,
  ): AsyncIterable<{ data: string }> {
    this.owner();
    const response = await this.artifact(workspaceId, artifactId, signal);
    for await (const chunk of response.body!) {
      for (let offset = 0; offset < chunk.length; offset += 65_536)
        yield { data: Buffer.from(chunk.subarray(offset, offset + 65_536)).toString('base64') };
    }
  }
  private async artifact(workspaceId: string, artifactId: string, signal: AbortSignal) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(artifactId)) throw new Error('Invalid artifact id');
    const ready = await this.getRuntime(workspaceId).process.start();
    const response = await fetch(`${ready.url}/api/v2/artifacts/${artifactId}/content`, {
      headers: { authorization: `Bearer ${ready.token}` },
      signal: AbortSignal.any([signal, this.lifetime.signal]),
    });
    if (!response.ok || !response.body) throw new Error('Artifact unavailable');
    return response;
  }
  /** Stream an Artifact into the selected export directory, publishing the file only after the complete copy succeeds. */
  @Remote
  async saveArtifact(
    workspaceId: string,
    artifactId: string,
    filename: string,
    signal: AbortSignal,
  ): Promise<{ saved: boolean; path: string }> {
    this.owner();
    const root = await this.exportRoot(workspaceId);
    const target = await containedFile(root, filename);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const response = await this.artifact(workspaceId, artifactId, signal);
    const file = await open(temporary, 'wx', 0o600);
    try {
      for await (const chunk of response.body!) await file.write(chunk);
      await file.sync();
      await file.close();
      await rename(temporary, target);
    } catch (error) {
      await file.close().catch(() => {});
      await rm(temporary, { force: true });
      throw error;
    }
    if (
      process.platform === 'darwin' &&
      this.ctx.get('directoryPicker')?.capability().kind === 'native'
    )
      await promisify(execFile)('/usr/bin/open', [target]).catch(() => undefined);
    return { saved: true, path: target };
  }
  private async hostCall(
    workspaceId: string,
    method: string,
    value: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    this.lifetime.signal.throwIfAborted();
    if (method === 'output.directory') {
      await this.selectExportDirectory(workspaceId, signal);
      return this.setCredential(workspaceId, 'output-directory', {
        path: await this.exportRoot(workspaceId),
      });
    }
    if (method === 'credential.prompt') {
      const { kind } = value as { kind: string };
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const abort = () => {
          clean();
          this.prompts.delete(id);
          reject(new Error('Credential input canceled'));
        };
        const timer = setTimeout(abort, 300_000);
        timer.unref();
        const clean = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          this.lifetime.signal.removeEventListener('abort', abort);
        };
        this.prompts.set(id, {
          workspaceId,
          kind,
          resolve: (result) => {
            clean();
            resolve(result);
          },
        });
        signal.addEventListener('abort', abort, { once: true });
        this.lifetime.signal.addEventListener('abort', abort, { once: true });
      });
    }
    if (method.startsWith('credential.')) {
      const input = value as { kind?: string; value?: Json; reference?: string };
      if (method === 'credential.put')
        return (await this.setCredential(workspaceId, input.kind!, input.value!)).reference;
      if (method === 'credential.resolve') {
        const record = await this.ctx.credentials.readRecord(
          this.key(workspaceId, input.reference!),
        );
        if (record?.kind !== 'grant') throw new Error('Credential unavailable');
        return record.payload;
      }
      if (method === 'credential.delete')
        return this.ctx.credentials.deleteRecord(this.key(workspaceId, input.reference!));
    }
    if (method === 'llm') {
      const input = value as {
        model: ModelSelection | null;
        request: { messages: Array<{ role: string; content: string }>; max_tokens?: number };
      };
      const model = input.model;
      if (!model) throw new Error('Configure a model in DSH');
      const messages = input.request.messages;
      let text = '';
      let inputTokens = 0;
      let outputTokens = 0;
      const stream = this.ctx.llm.stream({
        provider: model.provider,
        model: model.model,
        system: messages
          .filter((message) => message.role === 'system')
          .map((message) => message.content)
          .join('\n'),
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: messages
                  .filter((message) => message.role !== 'system')
                  .map((message) => message.content)
                  .join('\n'),
              },
            ],
          },
        ],
        ...(model.reasoningEffort
          ? { reasoningEffort: ReasoningEffortId(model.reasoningEffort) }
          : {}),
        maxTokens: input.request.max_tokens ?? 8192,
        signal: AbortSignal.any([signal, this.lifetime.signal]),
      });
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') {
          text += chunk.text;
          if (Buffer.byteLength(text) > 2_097_152)
            throw new Error('Model response exceeded its limit');
        }
        if (chunk.type === 'usage') {
          inputTokens = chunk.usage.inputTokens;
          outputTokens = chunk.usage.outputTokens;
        }
        if (chunk.type === 'finish' && ['error', 'aborted'].includes(chunk.reason.kind))
          throw new Error('DSH model request failed');
      }
      return { text, usage: { inputTokens, outputTokens } };
    }
    throw new Error('Unsupported host capability');
  }
  private async close(): Promise<void> {
    this.lifetime.abort();
    for (const prompt of this.prompts.values()) prompt.resolve({ canceled: true });
    this.prompts.clear();
    await Promise.allSettled([...this.runtimes.values()].map((entry) => entry.process.close()));
    this.runtimes.clear();
  }
}
export default ZhiYunService;
