import { describe, expect, it, vi } from 'vitest';
import { crawlPlanDefinitionSchema, taskCreateSchema } from '@zhiyun/shared';
import {
  BUILT_IN_EXAMPLE_PLAN,
  BUILT_IN_EXAMPLE_URL,
  builtInExampleTask,
  installBuiltInExampleTask,
  isBuiltInExampleTask,
} from '../src/example-task.js';

describe('built-in example task', () => {
  it('provides a conservative, schema-valid task and crawl plan', () => {
    const task = taskCreateSchema.parse(builtInExampleTask('zh-CN'));
    const plan = crawlPlanDefinitionSchema.parse(BUILT_IN_EXAMPLE_PLAN);

    expect(task.startUrl).toBe(BUILT_IN_EXAMPLE_URL);
    expect(task.schedule.mode).toBe('manual');
    expect(task.browserSettings.enabled).toBe(true);
    expect(task.requestSettings.respectRobotsTxt).toBe(true);
    expect(task.requestSettings).toMatchObject({ retries: 0, maxRequests: 1, delayMs: 5_000 });
    expect(plan.pagination).toEqual({ type: 'none' });
    expect(plan.limits).toMatchObject({ maxRequests: 1, maxRecords: 25 });
    expect(isBuiltInExampleTask(task)).toBe(true);
  });

  it('creates the task and its active rule together', async () => {
    const client = {
      createTask: vi.fn(async () => ({ id: 'example-id' })),
      createRule: vi.fn(async () => ({ rule: {}, version: {} })),
      deleteTask: vi.fn(async () => undefined),
    };

    await expect(installBuiltInExampleTask(client, 'en')).resolves.toBe('example-id');
    expect(client.createTask).toHaveBeenCalledOnce();
    expect(client.createRule).toHaveBeenCalledWith(
      'example-id',
      expect.objectContaining({ generatedBy: 'system', definition: BUILT_IN_EXAMPLE_PLAN }),
    );
    expect(client.deleteTask).not.toHaveBeenCalled();
  });

  it('removes a partial task when rule creation fails', async () => {
    const client = {
      createTask: vi.fn(async () => ({ id: 'partial-id' })),
      createRule: vi.fn(async () => {
        throw new Error('rule failed');
      }),
      deleteTask: vi.fn(async () => undefined),
    };

    await expect(installBuiltInExampleTask(client, 'zh-CN')).rejects.toThrow('rule failed');
    expect(client.deleteTask).toHaveBeenCalledWith('partial-id');
  });
});
