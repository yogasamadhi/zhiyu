import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { definePlatformRepositoryConformance } from '@zhiyun/platform-testkit';
import { openPostgresPlatformRepository } from '../src/index.js';

const baseConnectionString =
  process.env.DATABASE_URL ?? 'postgresql://zhiyun:zhiyun@localhost:45432/zhiyun';

definePlatformRepositoryConformance({
  name: 'PostgreSQL',
  async create() {
    const database = await createTemporaryDatabase();
    const repository = await openPostgresPlatformRepository({
      connectionString: database.connectionString,
      graphRevision: 'test-revision',
    });
    return {
      repository,
      async dispose() {
        await repository.close();
        await database.drop();
      },
    };
  },
});

describe('PostgreSQL 1.0 destructive reset', () => {
  it('drops only catalogued legacy tables and preserves unrelated tables', async () => {
    const database = await createTemporaryDatabase();
    const setup = postgres(database.connectionString, { max: 1 });
    await setup.unsafe(`
      CREATE TABLE tasks(id TEXT);
      CREATE TABLE rules(id TEXT);
      CREATE TABLE runs(id TEXT);
      CREATE TABLE records(id TEXT);
      CREATE TABLE customer_data(value TEXT);
      INSERT INTO customer_data VALUES ('keep');
    `);
    await setup.end();

    const repository = await openPostgresPlatformRepository({
      connectionString: database.connectionString,
      graphRevision: 'after-reset',
    });
    await repository.close();
    const verify = postgres(database.connectionString, { max: 1 });
    expect(await verify`SELECT value FROM customer_data`).toEqual([{ value: 'keep' }]);
    expect(await verify`SELECT product_schema_version FROM zhiyun_meta WHERE id=1`).toEqual([
      { product_schema_version: '1.0.0' },
    ]);
    const old = await verify`
      SELECT tablename FROM pg_catalog.pg_tables
      WHERE schemaname='public' AND tablename IN ('tasks','rules','runs','records')
    `;
    expect(old).toHaveLength(0);
    await verify.end();
    await database.drop();
  });

  it('refuses an unknown schema and preserves its data', async () => {
    const database = await createTemporaryDatabase();
    const setup = postgres(database.connectionString, { max: 1 });
    await setup.unsafe(
      "CREATE TABLE customer_data(value TEXT); INSERT INTO customer_data VALUES ('keep')",
    );
    await setup.end();

    await expect(
      openPostgresPlatformRepository({
        connectionString: database.connectionString,
        graphRevision: 'must-not-start',
      }),
    ).rejects.toThrow('Unknown PostgreSQL schema');
    const verify = postgres(database.connectionString, { max: 1 });
    expect(await verify`SELECT value FROM customer_data`).toEqual([{ value: 'keep' }]);
    await verify.end();
    await database.drop();
  });

  it('refuses migration checksum drift', async () => {
    const database = await createTemporaryDatabase();
    const repository = await openPostgresPlatformRepository({
      connectionString: database.connectionString,
      graphRevision: 'checksum-test',
    });
    await repository.close();
    const tamper = postgres(database.connectionString, { max: 1 });
    await tamper`UPDATE plugin_migrations SET checksum='tampered'`;
    await tamper.end();
    await expect(
      openPostgresPlatformRepository({
        connectionString: database.connectionString,
        graphRevision: 'must-fail',
      }),
    ).rejects.toThrow('Migration checksum mismatch');
    await database.drop();
  });
});

async function createTemporaryDatabase(): Promise<{
  connectionString: string;
  drop(): Promise<void>;
}> {
  const databaseName = `zhiyun_platform_${randomUUID().replaceAll('-', '')}`;
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
