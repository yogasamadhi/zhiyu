import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformRepository } from '@zhiyun/platform-core';
import { openPostgresPlatformRepository } from '@zhiyun/storage-postgres-v1';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import { PreferencesService } from '../src/application/index.js';
import type { PreferencesRepository } from '../src/contracts/index.js';
import { PostgresPreferencesRepository } from '../src/persistence/postgres/index.js';
import { SqlitePreferencesRepository } from '../src/persistence/sqlite/index.js';

interface Fixture {
  repository: PreferencesRepository;
  platform: PlatformRepository;
  dispose(): Promise<void>;
}

const content = {
  platform: 'fanqie' as const,
  contentType: 'novel' as const,
  externalId: 'book-42',
  title: 'Fixture novel',
  url: 'https://fanqienovel.com/page/42',
  coverUrl: null,
  author: null,
  summary: 'Fixture summary',
  tags: ['悬疑'],
  metadata: {},
};

definePreferencesConformance('SQLite', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'zhiyun-preferences-sqlite-'));
  const filePath = join(dataDirectory, 'zhiyun.sqlite3');
  const platform = await openSqlitePlatformRepository({
    dataDirectory,
    filePath,
    graphRevision: 'preferences-test',
  });
  const repository = new SqlitePreferencesRepository(filePath);
  await repository.migrate();
  return {
    repository,
    platform,
    async dispose() {
      await repository.close();
      await platform.close();
      await rm(dataDirectory, { recursive: true, force: true });
    },
  };
});

definePreferencesConformance('PostgreSQL', async () => {
  const database = await createTemporaryDatabase();
  const platform = await openPostgresPlatformRepository({
    connectionString: database.connectionString,
    graphRevision: 'preferences-test',
  });
  const repository = new PostgresPreferencesRepository(database.connectionString);
  await repository.migrate();
  return {
    repository,
    platform,
    async dispose() {
      await repository.close();
      await platform.close();
      await database.drop();
    },
  };
});

function definePreferencesConformance(name: string, create: () => Promise<Fixture>): void {
  describe(`${name} PreferencesRepository conformance`, () => {
    let fixture: Fixture;

    beforeAll(async () => {
      fixture = await create();
    });

    afterAll(async () => {
      if (fixture) await fixture.dispose();
    });

    it('records its forward-only Plugin migration', async () => {
      expect(await fixture.platform.listMigrations()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pluginId: 'preferences',
            migrationId: '001-initial',
            pluginVersion: '1.0.0',
          }),
        ]),
      );
    });

    it('owns trend bindings without a cross-domain foreign key', async () => {
      const created = await fixture.repository.upsertTrendSourceBinding({
        key: 'fixture.latest',
        platform: 'fanqie',
        taskId: 'collection-task-1',
        enabled: true,
        autoRefresh: true,
      });
      expect(created).toMatchObject({ taskId: 'collection-task-1', enabled: true });
      expect(
        await fixture.repository.updateTrendSourceBinding('fixture.latest', {
          enabled: false,
        }),
      ).toMatchObject({ enabled: false, autoRefresh: true });
      expect(await fixture.repository.clearTaskReference('collection-task-1')).toBe(1);
      expect(await fixture.repository.getTrendSourceBinding('fixture.latest')).toMatchObject({
        taskId: null,
      });
    });

    it('keeps completed evidence while replacing like with dislike idempotently', async () => {
      const service = new PreferencesService(fixture.repository);
      const liked = await service.setSignal({ kind: 'like', content });
      const repeated = await service.setSignal({ kind: 'like', content });
      expect(repeated.id).toBe(liked.id);
      await service.setSignal({ kind: 'completed', content });
      await service.setSignal({ kind: 'dislike', content });
      const stored = await service.listSignals(undefined, 100);
      expect(stored.items.map((signal) => signal.kind).sort()).toEqual(['completed', 'dislike']);
      expect(stored.items.every((signal) => signal.targetKey === 'fanqie:novel:book-42')).toBe(
        true,
      );
    });

    it('uses an opaque stable cursor and emits durable events with the same writes', async () => {
      const service = new PreferencesService(fixture.repository);
      await service.clearSignals();
      for (const externalId of ['cursor-1', 'cursor-2', 'cursor-3']) {
        await service.setSignal({
          kind: 'like',
          content: { ...content, externalId, title: externalId },
        });
      }
      const first = await service.listSignals(undefined, 2);
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = await service.listSignals(first.nextCursor!, 2);
      expect(second.items).toHaveLength(1);
      expect(new Set([...first.items, ...second.items].map(({ id }) => id)).size).toBe(3);
      const events = await fixture.platform.listEvents(0, 1_000);
      expect(events.map(({ type }) => type)).toEqual(
        expect.arrayContaining(['preferences.signal.updated', 'preferences.trend-source.updated']),
      );
    });
  });
}

async function createTemporaryDatabase(): Promise<{
  connectionString: string;
  drop(): Promise<void>;
}> {
  const baseConnectionString =
    process.env.DATABASE_URL ?? 'postgresql://zhiyun:zhiyun@localhost:45432/zhiyun';
  const databaseName = `zhiyun_preferences_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(baseConnectionString);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  await admin.end();
  const databaseUrl = new URL(baseConnectionString);
  databaseUrl.pathname = `/${databaseName}`;
  return {
    connectionString: databaseUrl.toString(),
    async drop() {
      const cleanup = postgres(adminUrl.toString(), { max: 1 });
      await cleanup`
        SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname=${databaseName} AND pid<>pg_backend_pid()
      `;
      await cleanup.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await cleanup.end();
    },
  };
}
