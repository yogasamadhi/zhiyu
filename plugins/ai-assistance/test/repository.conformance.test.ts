import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformRepository } from '@zhiyun/platform-core';
import { openPostgresPlatformRepository } from '@zhiyun/storage-postgres-v1';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import type { AiConversationRepository } from '../src/contracts/index.js';
import { emptyAiTaskDraft } from '../src/domain/index.js';
import { PostgresAiConversationRepository } from '../src/persistence/postgres/index.js';
import { SqliteAiConversationRepository } from '../src/persistence/sqlite/index.js';

interface Fixture {
  repository: AiConversationRepository;
  platform: PlatformRepository;
  dispose(): Promise<void>;
}

defineConformance('SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zhiyun-ai-conversations-'));
  const filePath = join(directory, 'zhiyun.sqlite3');
  const platform = await openSqlitePlatformRepository({
    dataDirectory: directory,
    filePath,
    graphRevision: 'ai-conformance',
  });
  const repository = new SqliteAiConversationRepository(filePath);
  await repository.migrate();
  return {
    repository,
    platform,
    async dispose() {
      await repository.close();
      await platform.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
});

if (process.env.DATABASE_URL)
  defineConformance('PostgreSQL', async () => {
    const database = await createTemporaryDatabase();
    const platform = await openPostgresPlatformRepository({
      connectionString: database.connectionString,
      graphRevision: 'ai-conformance',
    });
    const repository = new PostgresAiConversationRepository(database.connectionString);
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
else
  describe.skip('PostgreSQL AI ConversationRepository conformance', () => {
    it('requires DATABASE_URL', () => undefined);
  });

function defineConformance(name: string, create: () => Promise<Fixture>): void {
  describe(`${name} AI ConversationRepository conformance`, () => {
    let fixture: Fixture;

    beforeAll(async () => {
      fixture = await create();
    });
    afterAll(async () => fixture?.dispose());

    it('records the owned forward-only migration', async () => {
      expect(await fixture.platform.listMigrations()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pluginId: 'ai-assistance',
            migrationId: '001-conversations',
          }),
        ]),
      );
    });

    it('orders messages and increments immutable Draft revisions', async () => {
      const conversation = await fixture.repository.createConversation({ title: 'Fixture' });
      const turn = await fixture.repository.createTurn({ conversationId: conversation.id });
      await fixture.repository.appendMessage({
        conversationId: conversation.id,
        turnId: turn.id,
        role: 'user',
        content: 'first',
      });
      await fixture.repository.appendMessage({
        conversationId: conversation.id,
        turnId: turn.id,
        role: 'assistant',
        content: 'second',
      });
      expect(
        (await fixture.repository.listMessages(conversation.id)).map(({ content }) => content),
      ).toEqual(['first', 'second']);
      const first = await fixture.repository.createDraft(conversation.id, emptyAiTaskDraft());
      const second = await fixture.repository.createDraft(conversation.id, {
        ...first.draft,
        name: 'Products',
      });
      expect([first.revision, second.revision]).toEqual([1, 2]);
      expect(await fixture.repository.getLatestDraft(conversation.id)).toMatchObject({
        revision: 2,
        draft: { name: 'Products' },
      });
    });

    it('persists Turn usage and idempotent tool traces', async () => {
      const conversation = await fixture.repository.createConversation();
      const turn = await fixture.repository.createTurn({ conversationId: conversation.id });
      await fixture.repository.updateTurn(turn.id, {
        status: 'running',
        startedAt: new Date().toISOString(),
      });
      const first = await fixture.repository.createToolInvocation({
        conversationId: conversation.id,
        turnId: turn.id,
        toolCallId: 'call-1',
        name: 'search_sites',
        arguments: { query: 'products' },
      });
      const replay = await fixture.repository.createToolInvocation({
        conversationId: conversation.id,
        turnId: turn.id,
        toolCallId: 'call-1',
        name: 'search_sites',
        arguments: { query: 'ignored replay' },
      });
      expect(replay.id).toBe(first.id);
      await fixture.repository.updateToolInvocation(first.id, {
        status: 'succeeded',
        result: { candidates: [] },
      });
      await fixture.repository.updateTurn(turn.id, {
        status: 'succeeded',
        modelRounds: 2,
        toolCalls: 1,
        inputTokens: 30,
        outputTokens: 10,
        finishedAt: new Date().toISOString(),
      });
      expect(await fixture.repository.getTurn(turn.id)).toMatchObject({
        status: 'succeeded',
        modelRounds: 2,
        inputTokens: 30,
      });
      expect(await fixture.repository.listToolInvocations(turn.id)).toEqual([
        expect.objectContaining({ status: 'succeeded', result: { candidates: [] } }),
      ]);
    });

    it('uses optimistic Provider revisions and never returns secret values', async () => {
      const current = await fixture.repository.getProviderSettings();
      const updated = await fixture.repository.updateProviderSettings(
        {
          baseUrl: 'https://ai.example/v1',
          model: 'fixture',
          apiKeyRef: 'opaque-reference',
          testedAt: new Date().toISOString(),
        },
        current.revision,
      );
      expect(updated).toMatchObject({
        revision: current.revision + 1,
        apiKeyRef: 'opaque-reference',
      });
      await expect(
        fixture.repository.updateProviderSettings(
          { baseUrl: null, model: null, apiKeyRef: null, testedAt: null },
          current.revision,
        ),
      ).resolves.toBeNull();
      expect(JSON.stringify(updated)).not.toContain('secret-value');
    });

    it('archives, keyset-paginates and cleans inactive conversations without Task coupling', async () => {
      const archived = await fixture.repository.createConversation({ title: 'Archive me' });
      await fixture.repository.updateConversation(archived.id, {
        status: 'archived',
        archivedAt: new Date().toISOString(),
        committedTaskId: randomUUID(),
      });
      const page = await fixture.repository.listConversations(undefined, 1);
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toEqual(expect.any(String));
      expect(await fixture.repository.cleanupInactive('9999-01-01T00:00:00.000Z')).toBeGreaterThan(
        0,
      );
      expect(await fixture.repository.getConversation(archived.id)).toBeNull();
    });
  });
}

async function createTemporaryDatabase(): Promise<{
  connectionString: string;
  drop(): Promise<void>;
}> {
  const base = process.env.DATABASE_URL ?? 'postgresql://zhiyun:zhiyun@localhost:45432/zhiyun';
  const name = `zhiyun_ai_${randomUUID().replaceAll('-', '')}`;
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
