// Explicit local fixture: it never contacts an external model service.
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { writeFile, mkdir } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
export const inject = ['llm', 'workspaceRegistry', 'typertGateway', 'tools', 'agents'];
export async function apply(ctx, config) {
  await ctx.inject(['zhiyun'], async (ctx) => {
    if (config.stderr)
      ctx.effect(() => {
        const timer = setInterval(() => {
          void writeFile(
            config.stderr,
            JSON.stringify(
              [...ctx.zhiyun.runtimes.values()].map((entry) => entry.process.diagnostics),
            ),
          );
        }, 1000);
        return () => clearInterval(timer);
      }, 'fixture private diagnostics');
    const modelCalls = [];
    class FixtureProvider extends LlmAdapter {
      providerInfo(provider) {
        return { id: provider, name: 'ZhiYun acceptance fixture' };
      }
      async listModels(provider) {
        return ['fixture', 'fixture-agent'].map((id) => ({ provider, id, name: 'Local fixture' }));
      }
      async *stream(options) {
        options.signal?.throwIfAborted();
        modelCalls.push({ provider: options.provider, model: options.model });
        const prompt = options.messages
          .map((message) =>
            typeof message.content === 'string'
              ? message.content
              : message.content
                  .filter((block) => block.type === 'text')
                  .map((block) => block.text)
                  .join('\n'),
          )
          .join('\n');
        let input = {};
        try {
          input = JSON.parse(prompt);
        } catch {
          /* direct fixture call */
        }
        const value =
          input.candidate ??
          (input.requirement?.includes('fields')
            ? {
                fields: [
                  { name: 'name', type: 'string' },
                  { name: 'price', type: 'number' },
                ],
              }
            : {
                type: 'css',
                container: 'article',
                fields: {
                  name: { selector: 'h2', value: 'text', dataType: 'string' },
                  price: { selector: '.price', value: 'text', dataType: 'number' },
                },
              });
        yield { type: 'text-delta', index: 0, text: JSON.stringify(value) };
        yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 20 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    ctx.effect(
      () => ctx.llm.registerAdapter(['zhiyun-fixture'], new FixtureProvider()),
      'fixture model',
    );
    if (config.workspace) {
      await mkdir(config.workspace, { recursive: true });
      await ctx.workspaceRegistry.create(config.workspace, 'Fixture workspace B');
    }
    const peer = new Peer(ctx.root, { principal: { kind: 'fixture-guest' } });
    let denied = false;
    try {
      await ctx.typertGateway.invoke({ peer, namespace: 'zhiyun', method: 'workspaces', args: {} });
    } catch {
      denied = true;
    } finally {
      await peer.dispose();
    }
    assert.equal(denied, true);
    assert.ok(ctx.tools.get('zhiyun_workspaces'));
    const tool = await ctx.tools.execute({
      callId: 'zhiyun-fixture-workspaces',
      name: 'zhiyun_workspaces',
      arguments: {},
      signal: new AbortController().signal,
    });
    if (config.report)
      await writeFile(
        config.report,
        JSON.stringify(
          { nonOwnerDenied: denied, registryTool: tool, workspaces: ctx.zhiyun.workspaces() },
          null,
          2,
        ),
      );
    if (config.report)
      ctx.effect(() => {
        const timer = setTimeout(() => {
          void (async () => {
            const workspaces = ctx.zhiyun.workspaces();
            if (!workspaces[0]) return;
            const schema = await ctx.tools.execute({
              callId: 'zhiyun-fixture-schema',
              name: 'zhiyun_operation_schema',
              arguments: { workspaceId: workspaces[0].id, operationId: 'createTask' },
              signal: new AbortController().signal,
            });
            const listed = await ctx.tools.execute({
              callId: 'zhiyun-fixture-business',
              name: 'zhiyun_collection',
              arguments: { workspaceId: workspaces[0].id, operationId: 'listTasks' },
              signal: new AbortController().signal,
            });
            await writeFile(
              config.report,
              JSON.stringify(
                {
                  nonOwnerDenied: denied,
                  ...(config.auditStreams ? await auditStreams(ctx, workspaces[0].id) : {}),
                  ...(config.auditAgent
                    ? await auditAgentModel(ctx, workspaces[0].id, modelCalls)
                    : {}),
                  workspaces,
                  schemaTool: { isError: schema.isError, value: schema.value },
                  businessTool: { isError: listed.isError },
                },
                null,
                2,
              ),
            );
          })().catch((error) => {
            void writeFile(config.report + '.error', String(error));
          });
        }, 1000);
        return () => clearTimeout(timer);
      }, 'fixture tool registry audit');
  });
}

async function auditStreams(ctx, workspaceId) {
  const peer = new Peer(ctx.root, { principal: { kind: 'owner' } });
  const controllers = [];
  const read = async (after) => {
    const controller = new AbortController();
    controllers.push(controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
    const source = await ctx.typertGateway.stream({
      peer,
      namespace: 'zhiyun',
      method: 'events',
      args: { workspaceId, channel: 'domain', after },
      signal,
    });
    const iterator = source[Symbol.asyncIterator]();
    const next = await iterator.next();
    assert.equal(next.done, false);
    assert.equal(next.value.channel, 'domain');
    assert.ok(Number.isSafeInteger(next.value.data.cursor));
    controller.abort();
    await iterator.return().catch(() => {});
    return next.value.data.cursor;
  };
  try {
    const first = await read(0);
    const resumed = await read(first);
    assert.ok(resumed > first);
    const canceled = new AbortController();
    canceled.abort();
    await assert.rejects(
      ctx.typertGateway.invoke({
        peer,
        namespace: 'zhiyun',
        method: 'invoke',
        args: { input: { workspaceId, operationId: 'listTasks' } },
        signal: canceled.signal,
      }),
    );
    await assert.rejects(
      ctx.typertGateway.invoke({
        peer,
        namespace: 'zhiyun',
        method: 'setCredential',
        args: { workspaceId, kind: 'output-directory', value: { path: '/tmp/arbitrary-export' } },
      }),
    );
    return {
      eventReconnect: { first, resumed },
      gatewayCancellation: true,
      arbitraryDirectoryDenied: true,
    };
  } finally {
    for (const controller of controllers) controller.abort();
    await peer.dispose();
  }
}

async function auditAgentModel(ctx, workspaceId, modelCalls) {
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(
      '<main><article><h2>Fixture item</h2><span class="price">12</span></article><article><h2>Another item</h2><span class="price">24</span></article></main>',
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const handle = await ctx.agents.create({
    sessionId: randomUUID(),
    meta: {
      cwd: ctx.workspaceRegistry.list().find((workspace) => workspace.id === workspaceId).path,
    },
    agentOptions: { provider: 'zhiyun-fixture', model: 'fixture-agent' },
  });
  try {
    const controller = new AbortController();
    const created = await ctx.zhiyun.invokeFor(
      {
        workspaceId,
        operationId: 'createTask',
        body: {
          name: 'Agent model fixture',
          instruction: 'Extract name and price fields',
          startUrl: `http://127.0.0.1:${server.address().port}/`,
          networkPolicy: { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
        },
      },
      null,
      controller.signal,
    );
    assert.equal(created.status, 201);
    const result = await ctx.tools.execute({
      callId: randomUUID(),
      name: 'zhiyun_collection',
      agent: handle.agent,
      arguments: {
        workspaceId,
        operationId: 'analyzeTaskRule',
        path: { taskId: created.body.id },
        body: { useAi: true, forceBrowser: false },
      },
      signal: AbortSignal.timeout(120000),
    });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.value.status, 200, JSON.stringify(result));
    assert.equal(result.value.body.aiUsed, true, JSON.stringify(result));
    assert.ok(modelCalls.some((call) => call.model === 'fixture-agent'));
    return { agentModel: 'fixture-agent', agentToolAi: true };
  } finally {
    await handle.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
