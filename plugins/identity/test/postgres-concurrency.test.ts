import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPostgresPlatformRepository } from '@zhiyun/storage-postgres-v1';
import { PostgresIdentityRepository } from '../src/persistence/postgres/index.js';

const enabled = Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)('PostgreSQL identity concurrency', () => {
  let database: Awaited<ReturnType<typeof createTemporaryDatabase>>;
  let platform: Awaited<ReturnType<typeof openPostgresPlatformRepository>>;
  let repository: PostgresIdentityRepository;

  beforeAll(async () => {
    database = await createTemporaryDatabase();
    platform = await openPostgresPlatformRepository({
      connectionString: database.connectionString,
      graphRevision: 'identity-concurrency',
    });
    repository = new PostgresIdentityRepository(database.connectionString, 20);
    await repository.migrate();
  });

  afterAll(async () => {
    await repository?.close();
    await platform?.close();
    await database?.drop();
  });

  it('atomically admits only five simultaneous failures for one IP/email pair', async () => {
    const occurredAt = new Date();
    const reservations = await Promise.all(
      Array.from({ length: 20 }, () =>
        repository.reserveFailedLoginSlot({
          emailHash: 'same-email',
          networkHash: 'same-network',
          occurredAt,
          windowStartsAt: new Date(occurredAt.getTime() - 15 * 60_000),
          maximumFailures: 5,
        }),
      ),
    );

    expect(reservations.filter(Boolean)).toHaveLength(5);
    expect(
      await repository.countRecentFailedLogins(
        'same-email',
        'same-network',
        new Date(occurredAt.getTime() - 15 * 60_000),
      ),
    ).toBe(5);
  });
});

async function createTemporaryDatabase(): Promise<{
  connectionString: string;
  drop(): Promise<void>;
}> {
  const base = process.env.DATABASE_URL!;
  const name = `zhiyun_identity_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(base);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  await admin.end();
  const databaseUrl = new URL(base);
  databaseUrl.pathname = `/${name}`;
  return {
    connectionString: databaseUrl.toString(),
    async drop() {
      const cleanup = postgres(adminUrl.toString(), { max: 1 });
      await cleanup`
        SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname=${name} AND pid<>pg_backend_pid()
      `;
      await cleanup.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
      await cleanup.end();
    },
  };
}
