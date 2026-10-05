import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { crawlPlanDefinitionSchema, taskCreateSchema } from '@zhiyun/shared';
import {
  HONGGUO_CRAWL_PLAN,
  HONGGUO_TASK_URL,
  hongguoTask,
  installHongguoTask,
  isHongguoTask,
} from '../src/hongguo-task.js';

describe('Hongguo task preset', () => {
  it('provides a conservative task and a schema-valid plan', () => {
    const task = taskCreateSchema.parse(hongguoTask('zh-CN'));
    const plan = crawlPlanDefinitionSchema.parse(HONGGUO_CRAWL_PLAN);

    expect(task.startUrl).toBe(HONGGUO_TASK_URL);
    expect(task.browserSettings.enabled).toBe(false);
    expect(task.requestSettings).toMatchObject({
      retries: 0,
      concurrency: 1,
      delayMs: 1_500,
      maxRequests: 25,
      respectRobotsTxt: true,
    });
    expect(plan.discovery).toMatchObject({
      type: 'sitemap',
      include: ['/detail?series_id='],
      maxUrls: 20,
    });
    expect(plan.detail?.source).toMatchObject({
      type: 'script-json-assignment',
      marker: '_ROUTER_DATA =',
    });
    expect(plan.detail?.rule).toMatchObject({
      type: 'json',
      container: '$.loaderData.detail_page.seriesDetail',
    });
    expect(isHongguoTask(task)).toBe(true);
  });

  it('stays in sync with the documented CrawlPlan', () => {
    const documented = JSON.parse(
      readFileSync(
        new URL('../../../../docs/examples/hongguo-short-drama-plan.json', import.meta.url),
        'utf8',
      ),
    ) as unknown;
    expect(crawlPlanDefinitionSchema.parse(documented)).toEqual(HONGGUO_CRAWL_PLAN);
  });

  it('creates the task and active rule atomically from the UI perspective', async () => {
    const client = {
      createTask: vi.fn(async () => ({ id: 'hongguo-id' })),
      createRule: vi.fn(async () => ({ rule: {}, version: {} })),
      deleteTask: vi.fn(async () => undefined),
    };

    await expect(installHongguoTask(client, 'zh-CN')).resolves.toBe('hongguo-id');
    expect(client.createRule).toHaveBeenCalledWith(
      'hongguo-id',
      expect.objectContaining({ definition: HONGGUO_CRAWL_PLAN, generatedBy: 'system' }),
    );
    expect(client.deleteTask).not.toHaveBeenCalled();
  });

  it('deletes a partially created task when rule creation fails', async () => {
    const client = {
      createTask: vi.fn(async () => ({ id: 'partial-id' })),
      createRule: vi.fn(async () => {
        throw new Error('rule failed');
      }),
      deleteTask: vi.fn(async () => undefined),
    };

    await expect(installHongguoTask(client, 'en')).rejects.toThrow('rule failed');
    expect(client.deleteTask).toHaveBeenCalledWith('partial-id');
  });
});
