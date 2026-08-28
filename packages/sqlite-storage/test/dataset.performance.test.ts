import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { DefaultDataExporter } from '@zhiyun/exporters';
import { SqliteRepository } from '../src/index.js';

const enabled = process.env.ZHIYUN_PERFORMANCE === '1';

describe.skipIf(!enabled)('million-record Dataset performance', () => {
  it('uses cursor pagination and streams CSV without materializing the Dataset (performance)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zhiyun-million-dataset-'));
    const databasePath = join(directory, 'zhiyun.sqlite');
    const repository = new SqliteRepository(databasePath);
    try {
      await repository.migrate();
      const task = await repository.createTask({
        name: 'Million records',
        startUrl: 'https://example.com/products',
        instruction: 'Collect products',
        schedule: { mode: 'manual', timezone: 'Asia/Shanghai', misfirePolicy: 'skip' },
        requestSettings: {
          headers: {},
          cookies: [],
          timeoutMs: 30_000,
          retries: 2,
          retryBackoffMs: 1_000,
          concurrency: 2,
          delayMs: 0,
          maxRequests: 100,
          maxRuntimeMs: 300_000,
          domainRateLimitPerMinute: 60,
          respectRobotsTxt: true,
          maxResponseBytes: 20 * 1024 * 1024,
          redirectLimit: 10,
        },
        browserSettings: { enabled: false, waitUntil: 'domcontentloaded', actions: [] },
        pagination: { type: 'none' },
        outputSettings: { persistRecords: true },
        credentialBindings: {},
        datasetSettings: { mode: 'snapshot', keyFields: ['id'], detectRemoved: true },
        retentionPolicy: { runDays: null, maxRuns: null, artifactDays: null, logDays: null },
        networkPolicy: { allowPrivateNetworks: false, allowedHosts: [], allowedCidrs: [] },
        outputBindings: [],
      });
      const run = await repository.createRun(task.id);
      await repository.startRun(run.id, task.id);

      const raw = new Database(databasePath);
      try {
        raw.pragma('busy_timeout = 5000');
        raw.pragma('synchronous = OFF');
        const datasetId = crypto.randomUUID();
        const timestamp = new Date().toISOString();
        raw
          .prepare(
            'INSERT INTO datasets(id,task_id,settings,current_count,created_at,updated_at) VALUES (?,?,?,?,?,?)',
          )
          .run(
            datasetId,
            task.id,
            JSON.stringify({ mode: 'snapshot', keyFields: ['id'], detectRemoved: true }),
            1_000_000,
            timestamp,
            timestamp,
          );
        raw.exec(`
          WITH digits(n) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
          numbers(value) AS (
            SELECT a.n + b.n*10 + c.n*100 + d.n*1000 + e.n*10000 + f.n*100000
            FROM digits a, digits b, digits c, digits d, digits e, digits f
          )
          INSERT INTO dataset_records(
            id,dataset_id,task_id,record_key,source_url,data,content_hash,removed,
            first_run_id,last_run_id,first_seen_at,last_seen_at
          )
          SELECT
            printf('00000000-0000-4000-8000-%012x',value),
            '${datasetId}',
            '${task.id}',
            printf('%012d',value),
            'https://example.com/products/' || value,
            json_object('id',value,'name','Item ' || value,'price',value / 10.0),
            printf('%064x',value),
            0,
            '${run.id}',
            '${run.id}',
            '${timestamp}',
            '${timestamp}'
          FROM numbers;
        `);
        raw.prepare('UPDATE runs SET dataset_stats=? WHERE id=?').run(
          JSON.stringify({
            added: 1_000_000,
            updated: 0,
            removed: 0,
            unchanged: 0,
            current: 1_000_000,
          }),
          run.id,
        );
      } finally {
        raw.close();
      }

      const firstPageStarted = performance.now();
      const firstPage = await repository.listDatasetRecords(task.id, undefined, 500);
      expect(firstPage.items).toHaveLength(500);
      expect(firstPage.nextCursor).toEqual(expect.any(String));
      expect(performance.now() - firstPageStarted).toBeLessThan(5_000);
      const secondPage = await repository.listDatasetRecords(
        task.id,
        firstPage.nextCursor ?? undefined,
        500,
      );
      expect(secondPage.items).toHaveLength(500);
      expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);

      let recordCount = 0;
      async function* records() {
        let cursor: string | undefined;
        do {
          const page = await repository.listDatasetRecords(task.id, cursor, 10_000);
          for (const record of page.items) {
            recordCount += 1;
            yield record.data;
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
      }
      const exported = await new DefaultDataExporter().exportStream(records(), {
        format: 'csv',
        fields: ['id', 'name', 'price'],
        bom: false,
      });
      let bytes = 0;
      let chunks = 0;
      for await (const chunk of exported.data) {
        bytes += chunk.byteLength;
        chunks += 1;
      }
      expect(recordCount).toBe(1_000_000);
      expect(bytes).toBeGreaterThan(20_000_000);
      expect(chunks).toBeLessThan(2_000);
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 240_000);
});
