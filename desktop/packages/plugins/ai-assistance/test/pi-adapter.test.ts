import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpenAiCompatibleProvider, ScriptedChatProvider } from '@zhiyun/ai-runtime';
import type { AiChatRequest } from '@zhiyun/contracts';
import type { AgentRuntimeTool } from '../src/contracts/index.js';
import { emptyAiTaskDraft } from '../src/domain/index.js';
import { PiAgentRuntime } from '../src/application/pi-adapter.js';
import { trackedAiProvider } from '../src/application/cost-accounting.js';

let providerCalls = 0;
let operations: Record<string, number> = {};
function count(operation: string) {
  providerCalls++;
  operations[operation] = (operations[operation] ?? 0) + 1;
}
let toolExecutions = 0;
let started = 0;
class CountingScriptedProvider extends ScriptedChatProvider {
  override async generateSchema(input: Parameters<ScriptedChatProvider['generateSchema']>[0]) {
    count('generateSchema');
    return super.generateSchema(input);
  }
  override async *streamChat(input: AiChatRequest) {
    count('chat');
    yield* super.streamChat(input);
  }
}
beforeEach(() => {
  providerCalls = 0;
  operations = {};
  toolExecutions = 0;
  started = performance.now();
});
afterEach(({ task }) => {
  console.info(
    'AGENT_CASE_METRICS',
    JSON.stringify({
      fixtureVersion: 'repair-quality-v3',
      name: task.name,
      providerCalls,
      operations,
      toolExecutions,
      durationMs: performance.now() - started,
    }),
  );
});

function tool(
  name: AgentRuntimeTool['name'],
  execute: AgentRuntimeTool['execute'],
): AgentRuntimeTool {
  return {
    name,
    description: name,
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    execute: async (args, signal) => {
      toolExecutions++;
      return execute(args, signal);
    },
  };
}

describe('PiAgentRuntime security boundary', () => {
  it('executes only supplied crawler tools sequentially and streams lifecycle events', async () => {
    const provider = new CountingScriptedProvider([
      {
        toolCalls: [
          { id: 'one', name: 'update_task_draft', arguments: {} },
          { id: 'two', name: 'generate_rule', arguments: {} },
        ],
      },
      { text: '草稿和规则已准备。' },
    ]);
    const order: string[] = [];
    const events: string[] = [];
    const runtime = new PiAgentRuntime(() => provider);
    const result = await runtime.runTurn({
      conversationId: '00000000-0000-4000-8000-000000000001',
      messages: [{ role: 'user', content: '创建任务' }],
      facts: [],
      draft: emptyAiTaskDraft(),
      tools: [
        tool('update_task_draft', async () => {
          order.push('update');
          return { revision: 2 };
        }),
        tool('generate_rule', async () => {
          order.push('generate');
          return { rule: true };
        }),
      ],
      signal: new AbortController().signal,
      onEvent(event) {
        events.push(event.type);
      },
    });
    expect(order).toEqual(['update', 'generate']);
    expect(events).toEqual(expect.arrayContaining(['tool-start', 'tool-end', 'text-delta']));
    expect(result).toMatchObject({ content: '草稿和规则已准备。', modelRounds: 2, toolCalls: 2 });
  });

  it('does not expose shell, file, SQL, Python, or arbitrary HTTP tools', async () => {
    const provider = new CountingScriptedProvider([
      { toolCalls: [{ id: 'bad', name: 'shell', arguments: { command: 'pwd' } }] },
      { text: '无法执行。' },
    ]);
    let executed = false;
    const runtime = new PiAgentRuntime(() => provider);
    await runtime.runTurn({
      conversationId: '00000000-0000-4000-8000-000000000001',
      messages: [{ role: 'user', content: '运行 shell' }],
      facts: [],
      draft: emptyAiTaskDraft(),
      tools: [
        tool('present_draft', async () => {
          executed = true;
          return {};
        }),
      ],
      signal: new AbortController().signal,
      onEvent() {},
    });
    expect(executed).toBe(false);
  });

  it('honors cancellation before a provider request', async () => {
    const provider = new CountingScriptedProvider([{ text: 'should not complete' }]);
    const controller = new AbortController();
    controller.abort(new DOMException('Canceled', 'AbortError'));
    const runtime = new PiAgentRuntime(() => provider);
    await expect(
      runtime.runTurn({
        conversationId: '00000000-0000-4000-8000-000000000001',
        messages: [{ role: 'user', content: 'cancel' }],
        facts: [],
        draft: emptyAiTaskDraft(),
        tools: [],
        signal: controller.signal,
        onEvent() {},
      }),
    ).rejects.toThrow();
    expect(providerCalls).toBe(0);
  });

  it('propagates the turn deadline to an in-flight nested tool', async () => {
    const provider = new CountingScriptedProvider([
      { toolCalls: [{ id: 'slow', name: 'test_rule', arguments: {} }] },
    ]);
    let canceled = false;
    const runtime = new PiAgentRuntime(() => provider, {
      maxRounds: 8,
      maxToolCalls: 12,
      timeoutMs: 50,
    });
    await expect(
      runtime.runTurn({
        conversationId: crypto.randomUUID(),
        messages: [{ role: 'user', content: 'preview' }],
        facts: [],
        draft: emptyAiTaskDraft(),
        tools: [
          tool(
            'test_rule',
            async (_args, signal) =>
              new Promise((_resolve, reject) => {
                signal.addEventListener(
                  'abort',
                  () => {
                    canceled = true;
                    reject(new Error('Canceled'));
                  },
                  { once: true },
                );
              }),
          ),
        ],
        signal: new AbortController().signal,
        onEvent() {},
      }),
    ).rejects.toThrow('time budget');
    expect(canceled).toBe(true);
    expect(providerCalls).toBe(1);
  });

  it('rejects a supplied destructive tool without execution or a further provider call', async () => {
    const provider = new CountingScriptedProvider([
      { toolCalls: [{ id: 'bad', name: 'shell', arguments: {} }] },
      { text: 'This response must remain unused.' },
    ]);
    const runtime = new PiAgentRuntime(() => provider);
    const result = await runtime.runTurn({
      conversationId: crypto.randomUUID(),
      messages: [{ role: 'user', content: 'Untrusted request' }],
      facts: [],
      draft: emptyAiTaskDraft(),
      tools: [tool('shell' as AgentRuntimeTool['name'], async () => ({ activated: true }))],
      signal: new AbortController().signal,
      onEvent() {},
    });
    expect(result.modelRounds).toBe(1);
    expect(providerCalls).toBe(1);
    expect(toolExecutions).toBe(0);
  });

  it('stops a partially executed tool batch at its limit without a further provider call', async () => {
    const provider = new CountingScriptedProvider([
      {
        toolCalls: [
          { id: 'first', name: 'present_draft', arguments: {} },
          { id: 'blocked', name: 'generate_rule', arguments: {} },
        ],
      },
      { text: 'This response must remain unused.' },
    ]);
    const runtime = new PiAgentRuntime(() => provider, {
      maxRounds: 8,
      maxToolCalls: 1,
      timeoutMs: 5000,
    });
    const result = await runtime.runTurn({
      conversationId: crypto.randomUUID(),
      messages: [{ role: 'user', content: 'Bounded tools' }],
      facts: [],
      draft: emptyAiTaskDraft(),
      tools: [
        tool('present_draft', async () => ({})),
        tool('generate_rule', async () => ({ activated: true })),
      ],
      signal: new AbortController().signal,
      onEvent() {},
    });
    expect(result.modelRounds).toBe(1);
    expect(providerCalls).toBe(1);
    expect(toolExecutions).toBe(1);
  });

  it('labels Mock token and cost values explicitly rather than claiming settlement', async () => {
    const provider = new CountingScriptedProvider([{ text: 'Fixture response' }]);
    const result = await new PiAgentRuntime(() => provider).runTurn({
      conversationId: crypto.randomUUID(),
      messages: [{ role: 'user', content: 'Fixture' }],
      facts: [],
      draft: null,
      tools: [],
      signal: new AbortController().signal,
      onEvent() {},
    });
    expect(result).toMatchObject({
      accounting: {
        calls: 1,
        tokensSource: 'mock',
        inputTokens: 0,
        outputTokens: 0,
        costs: [{ source: 'mock', amount: 0, currency: 'CNY' }],
        unknownCostCalls: 0,
      },
    });
  });

  it('stops at the estimated cost limit before executing a returned tool or calling the provider again', async () => {
    const provider = new CountingScriptedProvider([
      { toolCalls: [{ id: 'blocked', name: 'generate_rule', arguments: {} }] },
      { text: 'This response must remain unused.' },
    ]);
    const result = await new PiAgentRuntime(() => provider).runTurn({
      conversationId: crypto.randomUUID(),
      messages: [{ role: 'user', content: 'Bounded costs' }],
      facts: [],
      draft: null,
      tools: [tool('generate_rule', async () => ({ activated: true }))],
      signal: new AbortController().signal,
      onEvent() {},
      ...{ costBudget: { maximum: 0.25, perCallEstimate: 0.25, currency: 'CNY' as const } },
    });
    expect(providerCalls).toBe(1);
    expect(toolExecutions).toBe(0);
    expect(result).toMatchObject({
      accounting: { calls: 1, estimatedCost: 0.25, stopReason: 'cost_limit' },
    });
  });

  it('shares the estimated budget with nested rule-generation calls and stops before another call', async () => {
    const provider = new CountingScriptedProvider([
      { toolCalls: [{ id: 'nested', name: 'generate_rule', arguments: {} }] },
      { text: 'Unused response' },
    ]);
    const result = await new PiAgentRuntime(() => provider).runTurn({
      conversationId: crypto.randomUUID(),
      messages: [{ role: 'user', content: 'Nested costs' }],
      facts: [],
      draft: null,
      tools: [
        tool('generate_rule', async () => {
          const nested = trackedAiProvider(provider);
          await nested.generateSchema({ instruction: 'name' });
          await nested.generateSchema({ instruction: 'price' });
          return {};
        }),
      ],
      signal: new AbortController().signal,
      onEvent() {},
      costBudget: { maximum: 0.5, perCallEstimate: 0.25, currency: 'CNY' },
    });
    expect(providerCalls).toBe(2);
    expect(toolExecutions).toBe(1);
    expect(result).toMatchObject({
      accounting: {
        calls: 2,
        estimatedCost: 0.5,
        stopReason: 'cost_limit',
        operations: { chat: 1, generateSchema: 1 },
      },
    });
  });

  function unmeteredProvider() {
    return new OpenAiCompatibleProvider({
      baseUrl: 'https://fixture.invalid/v1',
      model: 'transport-fixture',
      apiKey: async () => 'fixture-only',
      request: async () => {
        count('chat');
        return new Response(
          'data: {"choices":[{"delta":{"content":"Transport fixture"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
  }
  it('keeps missing provider token usage and settlement unknown instead of recording zero cost', async () => {
    const provider = unmeteredProvider();
    const result = await new PiAgentRuntime(() => provider).runTurn({
      conversationId: crypto.randomUUID(),
      messages: [{ role: 'user', content: 'Unknown accounting' }],
      facts: [],
      draft: null,
      tools: [],
      signal: new AbortController().signal,
      onEvent() {},
    });
    expect(providerCalls).toBe(1);
    expect(result).toMatchObject({
      accounting: {
        calls: 1,
        inputTokens: null,
        outputTokens: null,
        tokensSource: 'unknown',
        costs: [],
        unknownCostCalls: 1,
      },
    });
  });
  it('stops an unpriced provider before its first request when an estimated limit is required', async () => {
    const provider = unmeteredProvider();
    const result = await new PiAgentRuntime(() => provider).runTurn({
      conversationId: crypto.randomUUID(),
      messages: [{ role: 'user', content: 'Unpriced limit' }],
      facts: [],
      draft: null,
      tools: [],
      signal: new AbortController().signal,
      onEvent() {},
      costBudget: { maximum: 0.5, perCallEstimate: null, currency: 'CNY' },
    });
    expect(providerCalls).toBe(0);
    expect(result).toMatchObject({
      modelRounds: 0,
      accounting: { calls: 0, tokensSource: 'unknown', stopReason: 'estimate_unavailable' },
    });
  });
  it('retains the reported token source and settlement currency without converting them to estimates', async () => {
    const provider = new CountingScriptedProvider([
      {
        text: 'Settlement fixture',
        usage: {
          inputTokens: 12,
          outputTokens: 8,
          totalTokens: 20,
          tokensSource: 'reported',
          cost: { source: 'settled', amount: 0.04, currency: 'USD' },
        },
      },
    ]);
    const result = await new PiAgentRuntime(() => provider).runTurn({
      conversationId: crypto.randomUUID(),
      messages: [{ role: 'user', content: 'Settlement' }],
      facts: [],
      draft: null,
      tools: [],
      signal: new AbortController().signal,
      onEvent() {},
    });
    expect(result).toMatchObject({
      accounting: {
        calls: 1,
        tokensSource: 'reported',
        inputTokens: 12,
        outputTokens: 8,
        costs: [{ source: 'settled', amount: 0.04, currency: 'USD' }],
        estimatedCost: null,
      },
    });
  });
});
