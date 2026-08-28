import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformRepository } from '@zhiyun/platform-core';
import { openPostgresPlatformRepository } from '@zhiyun/storage-postgres-v1';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import { OutputsService } from '../src/application/index.js';
import type { OutputRepository } from '../src/contracts/index.js';
import { PostgresOutputRepository } from '../src/persistence/postgres/index.js';
import { SqliteOutputRepository } from '../src/persistence/sqlite/index.js';

interface Fixture {
  repository: OutputRepository;
  platform: PlatformRepository;
  dispose(): Promise<void>;
}

defineOutputConformance('SQLite', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'zhiyun-outputs-sqlite-'));
  const filePath = join(dataDirectory, 'zhiyun.sqlite3');
  const platform = await openSqlitePlatformRepository({
    dataDirectory,
    filePath,
    graphRevision: 'outputs-test',
  });
  const repository = new SqliteOutputRepository(filePath);
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

defineOutputConformance('PostgreSQL', async () => {
  const database = await createTemporaryDatabase();
  const platform = await openPostgresPlatformRepository({
    connectionString: database.connectionString,
    graphRevision: 'outputs-test',
  });
  const repository = new PostgresOutputRepository(database.connectionString);
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

function defineOutputConformance(name: string, create: () => Promise<Fixture>): void {
  describe(`${name} OutputRepository conformance`, () => {
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
            pluginId: 'outputs',
            migrationId: '001-initial',
            pluginVersion: '1.0.0',
          }),
        ]),
      );
    });

    it('owns Destination CRUD and task bindings atomically', async () => {
      const destination = await fixture.repository.createDestination({
        name: 'Fixture webhook',
        type: 'webhook',
        config: { url: 'https://example.com/hook' },
        credentialRef: 'credential-fixture',
        enabled: true,
      });
      const taskId = randomUUID();
      const service = new OutputsService(fixture.repository);
      await service.bindTask(taskId, [destination.id, destination.id]);
      expect(await fixture.repository.listTaskBindings(taskId)).toEqual([destination.id]);
      await expect(service.bindTask(taskId, [randomUUID()])).rejects.toThrow();
      expect(await fixture.repository.listTaskBindings(taskId)).toEqual([destination.id]);
      expect(
        await fixture.repository.updateDestination(destination.id, {
          name: 'Updated webhook',
          enabled: false,
        }),
      ).toMatchObject({ name: 'Updated webhook', enabled: false });
      expect(await fixture.repository.deleteDestination(destination.id)).toBe(true);
      expect(await fixture.repository.listTaskBindings(taskId)).toEqual([]);
    });

    it('persists Delivery Attempt lifecycle and emits terminal durable events', async () => {
      const attempt = await fixture.repository.createDeliveryAttempt({
        destinationId: randomUUID(),
        taskId: randomUUID(),
        runId: randomUUID(),
      });
      expect(attempt).toMatchObject({ status: 'pending', attempt: 1 });
      const completed = await fixture.repository.updateDeliveryAttempt(attempt.id, {
        status: 'succeeded',
        responseStatus: 204,
      });
      expect(completed).toMatchObject({ status: 'succeeded', responseStatus: 204 });
      expect(await fixture.repository.listDeliveryAttempts(attempt.runId)).toEqual([completed]);
      const events = await fixture.platform.listEvents(0, 1_000);
      expect(events.map(({ type }) => type)).toContain('outputs.delivery.succeeded');
    });

    it('stores only API token hashes and revokes tokens idempotently', async () => {
      const tokenHash = `hash-${randomUUID()}`;
      const token = await fixture.repository.createApiToken({
        name: 'Fixture token',
        taskIds: [randomUUID()],
        rateLimitPerMinute: 120,
        expiresAt: null,
        tokenHash,
      });
      expect(await fixture.repository.findApiToken(tokenHash)).toEqual(token);
      expect(JSON.stringify(await fixture.repository.listApiTokens())).not.toContain(tokenHash);
      expect(await fixture.repository.revokeApiToken(token.id)).toBe(true);
      expect(await fixture.repository.revokeApiToken(token.id)).toBe(false);
      expect(await fixture.repository.findApiToken(tokenHash)).toBeNull();
    });
  });
}

async function createTemporaryDatabase(): Promise<{
  connectionString: string;
  drop(): Promise<void>;
}> {
  const baseConnectionString =
    process.env.DATABASE_URL ?? 'postgresql://zhiyun:zhiyun@localhost:45432/zhiyun';
  const databaseName = `zhiyun_outputs_${randomUUID().replaceAll('-', '')}`;
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
