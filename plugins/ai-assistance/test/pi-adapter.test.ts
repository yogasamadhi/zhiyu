import { describe, expect, it } from 'vitest';
import { ScriptedChatProvider } from '@zhiyun/ai-runtime';
import type { AgentRuntimeTool } from '../src/contracts/index.js';
import { emptyAiTaskDraft } from '../src/domain/index.js';
import { PiAgentRuntime } from '../src/application/pi-adapter.js';

function tool(
  name: AgentRuntimeTool['name'],
  execute: AgentRuntimeTool['execute'],
): AgentRuntimeTool {
  return {
    name,
    description: name,
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    execute,
  };
}

describe('PiAgentRuntime security boundary', () => {
  it('executes only supplied crawler tools sequentially and streams lifecycle events', async () => {
    const provider = new ScriptedChatProvider([
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
    const provider = new ScriptedChatProvider([
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
    const provider = new ScriptedChatProvider([{ text: 'should not complete' }]);
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
  });
});
