import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  monitoringAlertSchema,
  monitoringAlertRunPageSchema,
  monitoringAlertPageSchema,
  qualityPolicySchema,
} from '@zhiyun/shared';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import {
  MonitoringService,
  SqliteMonitoringRepository,
  registerMonitoringHttp,
} from '../src/index.js';

describe('local monitoring HTTP history', () => {
  it('pages every aggregated Run, validates scoped cursors and preserves dismissed evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zhiyun-monitoring-http-'));
    const filePath = join(directory, 'zhiyun.sqlite3');
    const platform = await openSqlitePlatformRepository({
      dataDirectory: directory,
      filePath,
      graphRevision: 'monitoring-http',
    });
    const repository = new SqliteMonitoringRepository(filePath),
      app = Fastify();
    const taskId: string = crypto.randomUUID(),
      otherTask: string = crypto.randomUUID();
    const service = new MonitoringService(repository);
    const root = `/api/v2/tasks/${taskId}/monitoring-alerts`;
    try {
      await repository.migrate();
      await repository.upsertPolicy(
        taskId,
        qualityPolicySchema.parse({
          rules: [{ kind: 'run-failed', aggregationSeconds: 3600, cooldownSeconds: 3600 }],
        }),
      );
      await registerMonitoringHttp(app, {
        repository,
        tasks: { getTask: async (id) => ([taskId, otherTask].includes(id) ? {} : null) },
      });
      const runIds: string[] = [];
      for (let index = 0; index < 205; index++) {
        const runId = crypto.randomUUID();
        runIds.push(runId);
        await service.recordFailed({ taskId, runId, error: 'PRIVATE fixture error' });
      }
      const response = await app.inject({ method: 'GET', url: root });
      expect(response.statusCode).toBe(200);
      const alert = monitoringAlertSchema.parse(response.json().items[0]);
      expect(alert).toMatchObject({
        occurrenceCount: 205,
        notificationCount: 1,
        suppressedCount: 204,
      });
      expect(alert.runs).toHaveLength(20);
      const traceUrl = `${root}/${alert.id}/runs`;
      const read: string[] = [];
      let cursor: string | null = null,
        firstCursor: string | null = null;
      do {
        const pageResponse = await app.inject({
          method: 'GET',
          url: `${traceUrl}?limit=17${cursor ? `&cursor=${cursor}` : ''}`,
        });
        expect(pageResponse.statusCode).toBe(200);
        const page = monitoringAlertRunPageSchema.parse(pageResponse.json());
        read.push(...page.items.map((item) => item.runId));
        cursor = page.nextCursor;
        firstCursor ??= cursor;
      } while (cursor);
      expect(read).toEqual([...runIds].reverse());
      expect(new Set(read).size).toBe(205);
      for (const badQuery of [
        'limit=0',
        'limit=501',
        'limit=',
        'limit=1.1',
        'limit=abc',
        'cursor=',
        'cursor=%%%',
      ])
        expect(
          (await app.inject({ method: 'GET', url: `${traceUrl}?${badQuery}` })).statusCode,
        ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v2/tasks/${otherTask}/monitoring-alerts/${alert.id}/runs?cursor=${firstCursor}`,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v2/tasks/${otherTask}/monitoring-alerts/${alert.id}/runs`,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v2/tasks/${crypto.randomUUID()}/monitoring-alerts`,
          })
        ).statusCode,
      ).toBe(404);
      expect((await app.inject({ method: 'DELETE', url: `${root}/${alert.id}` })).statusCode).toBe(
        400,
      );
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/api/v2/tasks/${otherTask}/monitoring-alerts/${alert.id}`,
            headers: { 'idempotency-key': crypto.randomUUID() },
          })
        ).statusCode,
      ).toBe(404);
      for (let index = 0; index < 2; index++) {
        const dismissed = await app.inject({
          method: 'DELETE',
          url: `${root}/${alert.id}`,
          headers: { 'idempotency-key': crypto.randomUUID() },
        });
        expect(dismissed.statusCode).toBe(200);
        expect(monitoringAlertSchema.parse(dismissed.json()).status).toBe('dismissed');
      }
      expect(
        monitoringAlertRunPageSchema.parse(
          (await app.inject({ method: 'GET', url: traceUrl })).json(),
        ).items,
      ).toHaveLength(50);
      const events = await platform.listEvents(0, 1000);
      expect(events.filter((event) => event.type === 'monitoring.alert.created')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'monitoring.alert.updated')).toHaveLength(204);
      expect(events.filter((event) => event.type === 'monitoring.alert.deleted')).toHaveLength(1);
      expect(
        JSON.stringify(events.filter((event) => event.type === 'quality.issue.detected')),
      ).not.toContain('PRIVATE');
      await repository.upsertPolicy(
        otherTask,
        qualityPolicySchema.parse({
          rules: [{ kind: 'run-failed', aggregationSeconds: 0, cooldownSeconds: 0 }],
        }),
      );
      const separateIds: string[] = [];
      for (let index = 0; index < 205; index++) {
        await service.recordFailed({
          taskId: otherTask,
          runId: crypto.randomUUID(),
          error: 'Owned event fixture',
        });
        separateIds.push((await repository.listAlertsPage(otherTask, undefined, 1)).items[0]!.id);
      }
      // Deliberately tie every immutable creation timestamp in this owned test database.
      const database = new Database(filePath);
      database
        .prepare('UPDATE quality_alerts SET first_at=? WHERE task_id=?')
        .run('2026-01-01T00:00:00.000Z', otherTask);
      database.close();
      const listUrl = `/api/v2/tasks/${otherTask}/monitoring-alerts`;
      const alertIds: string[] = [];
      let listCursor: string | null = null,
        listFirstCursor: string | null = null;
      do {
        const pageResponse = await app.inject({
          method: 'GET',
          url: `${listUrl}?limit=17${listCursor ? `&cursor=${listCursor}` : ''}`,
        });
        expect(pageResponse.statusCode).toBe(200);
        const page = monitoringAlertPageSchema.parse(pageResponse.json());
        alertIds.push(...page.items.map((item) => item.id));
        listCursor = page.nextCursor;
        listFirstCursor ??= listCursor;
      } while (listCursor);
      expect(alertIds).toEqual([...separateIds].sort().reverse());
      expect(new Set(alertIds).size).toBe(205);
      expect(
        (await app.inject({ method: 'GET', url: `${root}?cursor=${listFirstCursor}` })).statusCode,
      ).toBe(400);
      for (const invalid of ['cursor=', 'cursor=%%%', 'limit=501', `cursor=${firstCursor}`])
        expect((await app.inject({ method: 'GET', url: `${listUrl}?${invalid}` })).statusCode).toBe(
          400,
        );
    } finally {
      await app.close();
      await repository.close();
      await platform.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
