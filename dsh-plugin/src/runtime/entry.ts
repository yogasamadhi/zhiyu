import childProcesses from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { AnalyticsWorkerSupervisor } from '@zhiyun/analytics-worker-client';
import { OpenAiCompatibleProvider, type AiUsage } from '@zhiyun/ai-runtime';
import { assertNetworkAllowed } from '@zhiyun/crawler-runtime';
import { buildDesktopRuntime, openApiDocument, type Level2Runtime } from '@zhiyun/runtime';
import { RpcPeer } from '../shared/rpc.js';
import { redactSensitiveText } from '@zhiyun/shared';
import type { Bootstrap, ModelSelection, RpcMessage, RuntimeReady } from '../shared/protocol.js';

if (!process.send) throw new Error('Start this runtime through the DSH plugin');
const send = (message: RpcMessage) => process.connected && process.send!(message);
const models = new AsyncLocalStorage<ModelSelection | null>();
let bootstrap: Bootstrap;
let runtime: Level2Runtime | undefined;
let supervisor: AnalyticsWorkerSupervisor | undefined;
let stopping: Promise<void> | undefined;
let lockOwned = false;
const browsers = new Set<Browser>();
const rpc = new RpcPeer(
  send,
  async (method, value) => {
    if (method === 'model.default') {
      bootstrap.model = value as ModelSelection | null;
      return true;
    }
    if (method === 'bootstrap') return start(value as Bootstrap);
    if (method === 'shutdown') {
      void stop().then(() => process.exit(0));
      return true;
    }
    throw new Error('Unknown runtime command');
  },
  (error) =>
    console.error(
      redactSensitiveText(
        error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error),
      ),
    ),
);
// Report process ownership before returning a new child to a dependency. The Host
// can release Worker and Chromium process groups even after this Runtime is killed.
const originalSpawn = childProcesses.spawn;
childProcesses.spawn = function (...args: Parameters<typeof originalSpawn>) {
  const child = originalSpawn(...args);
  if (child.pid) {
    const pid = child.pid;
    void rpc.call('process.track', { pid }).catch(() => {});
    child.once('exit', () => {
      void rpc.call('process.untrack', { pid }).catch(() => {});
    });
  }
  return child;
} as typeof originalSpawn;
syncBuiltinESMExports();
process.on('message', (message) => rpc.receive(message as RpcMessage));
process.on('disconnect', () => {
  void stop().finally(() => process.exit());
});
process.on('SIGTERM', () => {
  void stop().finally(() => process.exit());
});

async function lock(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, '.runtime.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, 'wx', 0o600);
      await file.writeFile(String(process.pid));
      await file.close();
      lockOwned = true;
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(path, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1)
        throw new Error('Invalid runtime lock', { cause: error });
      try {
        process.kill(pid, 0);
        throw new Error('Workspace runtime is already active', { cause: error });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw cause;
      }
      await rm(path);
    }
  }
  throw new Error('Cannot acquire runtime lock');
}

function activeModel(): ModelSelection | null {
  const model = models.getStore();
  return model === undefined ? bootstrap.model : model;
}

async function start(input: Bootstrap): Promise<RuntimeReady> {
  if (runtime || bootstrap) throw new Error('Already bootstrapped');
  bootstrap = input;
  await lock(input.dataDirectory);
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(input.resources, 'playwright');
  process.env.CRAWLEE_STORAGE_DIR = join(input.dataDirectory, 'crawlee');
  const credentials = {
    put: (kind: string, value: unknown) => rpc.call<string>('credential.put', { kind, value }),
    resolve: <T>(reference: string) => rpc.call<T>('credential.resolve', { reference }),
    delete: (reference: string) => rpc.call<void>('credential.delete', { reference }),
  };
  class Provider extends OpenAiCompatibleProvider {
    override get cacheIdentity() {
      const model = activeModel();
      return {
        ...super.cacheIdentity!,
        provider: model?.provider ?? 'dsh',
        model: model?.model ?? 'unconfigured',
        configuration: createHash('sha256').update(JSON.stringify(model)).digest('hex'),
      };
    }
  }
  const provider = (onUsage: (usage: AiUsage) => Promise<void>) =>
    new Provider({
      onUsage: async (usage) => {
        const model = activeModel();
        const recorded = {
          ...usage,
          model: model?.model ?? 'unconfigured',
          dshProvider: model?.provider ?? null,
          billingSource: 'dsh',
        };
        await onUsage(recorded);
      },
      baseUrl: 'https://dsh.invalid/v1',
      model: 'dsh-selected',
      apiKey: async () => 'host-reference',
      retries: 0,
      request: async (_url, init) => {
        const request = JSON.parse(String(init.body)) as Record<string, unknown>;
        const result = await rpc.call<{
          text: string;
          usage: { inputTokens: number; outputTokens: number };
        }>('llm', { request, model: activeModel() }, init.signal ?? undefined);
        const usage = {
          prompt_tokens: result.usage.inputTokens,
          completion_tokens: result.usage.outputTokens,
          total_tokens: result.usage.inputTokens + result.usage.outputTokens,
        };
        if (request.stream)
          return new Response(
            `data: ${JSON.stringify({ choices: [{ delta: { content: result.text } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          );
        return Response.json({ choices: [{ message: { content: result.text } }], usage });
      },
    });
  let connection;
  let workerStatus: 'ready' | 'degraded' = 'degraded';
  supervisor = new AnalyticsWorkerSupervisor({
    startupTimeoutMs: 120_000,
    command: join(input.resources, 'worker/analytics-worker'),
    workspaceRoot: join(input.dataDirectory, 'job-workspaces'),
    onStateChange(state) {
      if (runtime && state.status === 'ready')
        void supervisor!
          .start()
          .then((client) =>
            runtime?.setAnalyticsWorker(new (requireWorkerClient())(client), 'ready'),
          );
      if (runtime && state.status === 'degraded') runtime.setAnalyticsWorker(undefined, 'degraded');
    },
  });
  try {
    connection = await supervisor.start();
    workerStatus = 'ready';
  } catch {
    /* Collection remains available. */
  }
  const nonce = randomUUID();
  runtime = await buildDesktopRuntime(
    {
      dataDirectory: input.dataDirectory,
      hostBaseUrl: '',
      hostToken: '',
      credentialStore: credentials,
      jobContext: {
        capture: () => ({ model: activeModel() }),
        run: (context, work) =>
          models.run(
            'model' in context ? (context.model as ModelSelection | null) : bootstrap.model,
            work,
          ),
      },
      aiProvider: provider,
      schedulingEnvironment: { online: true, suspended: false },
      ...(connection ? { analyticsWorker: connection } : {}),
      hostedAi: {
        enabled: () => false,
        configuration: () => ({ provider: 'dsh', model: '', configuration: 'dsh' }),
        request: async () => {
          throw new Error('Use DSH model service');
        },
      },
      openApiDocument: openApiDocument('dsh-studio'),
      host: {
        metadata: {
          runtimeId: randomUUID(),
          generation: input.generation,
          apiVersion: 'v2',
          mode: 'desktop',
          productVersion: '1.0.0',
          analyticsWorkerStatus: workerStatus,
          startedAt: new Date().toISOString(),
        },
        capabilities: {
          platform: process.platform === 'darwin' ? 'darwin' : 'win32',
          browser: true,
          cron: true,
          credentials: true,
          artifactSaveDialog: false,
          notifications: false,
          tray: false,
        },
        async createLoginSession(url) {
          await assertNetworkAllowed(url);
          const browser = await chromium.launch({ headless: false });
          browsers.add(browser);
          const context = await browser.newContext();
          const page = await context.newPage();
          await context.route('**/*', async (route) => {
            try {
              await assertNetworkAllowed(route.request().url());
              await route.continue();
            } catch {
              await route.abort();
            }
          });
          return new Promise<{ reference: string } | { canceled: true }>((resolveLogin, reject) => {
            browser.on('disconnected', () => {
              browsers.delete(browser);
              resolveLogin({ canceled: true });
            });
            void page
              .exposeFunction('__zhiyunSaveLogin', async () => {
                try {
                  const reference = await credentials.put(
                    'task-browser-session',
                    await context.storageState(),
                  );
                  resolveLogin({ reference });
                  await browser.close();
                } catch {
                  reject(new Error('Cannot save login session'));
                  await browser.close();
                }
              })
              .then(async () => {
                await page.addInitScript(() => {
                  addEventListener('DOMContentLoaded', () => {
                    const button = document.createElement('button');
                    button.textContent = '完成登录并保存到织云 / Save login';
                    button.style.cssText =
                      'position:fixed;right:16px;top:16px;z-index:2147483647;padding:12px;background:#147d75;color:white;border:0';
                    button.onclick = () => {
                      void (
                        window as unknown as { __zhiyunSaveLogin(): Promise<void> }
                      ).__zhiyunSaveLogin();
                    };
                    document.body.append(button);
                  });
                });
                await page.goto(url);
              })
              .catch(reject);
          });
        },
        async promptCredential(kind) {
          return rpc.call<{ reference: string } | { canceled: true }>('credential.prompt', {
            kind,
          });
        },
        async selectOutputDirectory() {
          return rpc.call<{ reference: string }>('output.directory', {});
        },
      },
    },
    { profileId: 'dsh-studio', sessionNonce: nonce, allowedOrigins: [], logger: false },
  );
  runtime.app.addHook('onRequest', (request, _reply, done) => {
    const encoded = request.headers['x-zhiyun-model'];
    const selected =
      typeof encoded === 'string'
        ? (JSON.parse(Buffer.from(encoded, 'base64url').toString()) as ModelSelection | null)
        : bootstrap.model;
    models.run(selected, done);
  });
  const url = await runtime.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(`${url}/api/v2/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce }),
  });
  if (!response.ok) throw new Error('Runtime authentication failed');
  const { token } = (await response.json()) as { token: string };
  return {
    url,
    token,
    generation: input.generation,
    routes: (
      (await (
        await fetch(`${url}/api/v2/runtime/graph`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()) as { routes: RuntimeReady['routes'] }
    ).routes,
  };
}

// Static import is intentionally confined to the private runtime compilation.
import { AnalyticsWorkerClient as WorkerClient } from '@zhiyun/analytics-worker-client';
function requireWorkerClient() {
  return WorkerClient;
}
async function stop(): Promise<void> {
  return (stopping ??= (async () => {
    for (const browser of browsers) await browser.close().catch(() => {});
    try {
      await runtime?.close();
    } finally {
      await supervisor?.stop();
      rpc.close();
      if (lockOwned) await rm(join(bootstrap.dataDirectory, '.runtime.lock'), { force: true });
    }
  })());
}
