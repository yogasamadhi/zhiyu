import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import type { PlatformJobQueue } from '@zhiyun/platform-core';
import { normalizeCrawlPlan, type CollectionDraft } from '@zhiyun/shared';
import { SqliteCollectionRepository } from '../src/persistence/sqlite/index.js';
import { registerCollectionHttp, type CollectionHttpDependencies } from '../src/http/index.js';
import { executeProductExample } from '../src/domain/example.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture(
  login?: () => Promise<{ reference: string } | { canceled: true }>,
  previewRule?: CollectionHttpDependencies['previewRule'],
) {
  const directory = await mkdtemp(join(tmpdir(), 'zhiyun-draft-'));
  const filePath = join(directory, 'zhiyun.sqlite3');
  const platform = await openSqlitePlatformRepository({
    dataDirectory: directory,
    filePath,
    graphRevision: 'draft-test',
  });
  const repository = new SqliteCollectionRepository(filePath);
  await repository.migrate();
  const app = Fastify();
  const enqueue = vi.fn(async () => ({}));
  const deleteCredential = vi.fn(async () => undefined);
  await registerCollectionHttp(app, {
    repository,
    platform,
    jobs: { enqueue } as unknown as PlatformJobQueue,
    credentialStore: {
      put: async () => 'protected',
      resolve: async <T>() => undefined as T,
      delete: deleteCredential,
    },
    runtimeMode: 'headless',
    ...(login ? { createLoginSession: login } : {}),
    ...(previewRule ? { previewRule } : {}),
  });
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    await repository.close();
    await platform.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { app, repository, platform, enqueue, filePath, deleteCredential };
}
describe('unified collection drafts', () => {
  it('persists preview field diagnostics, replays them idempotently, and refuses an invalid executable rule', async () => {
    const { app, repository, enqueue } = await fixture();
    let draft = (
      await app.inject({
        method: 'POST',
        url: '/api/v2/examples/products/drafts',
        headers: { 'idempotency-key': 'quality-draft' },
        payload: {},
      })
    ).json<CollectionDraft>();
    const request = () =>
      app.inject({
        method: 'POST',
        url: `/api/v2/collection-drafts/${draft.id}/preview`,
        headers: { 'idempotency-key': 'quality-preview', 'if-match': `"${draft.revision}"` },
      });
    const first = await request();
    expect(first.statusCode, first.body).toBe(200);
    expect((await request()).json()).toEqual(first.json());
    draft = first.json<CollectionDraft>();
    expect(draft.preview?.records[0]?.inspection?.fields['价格']).toEqual({
      status: 'valid',
      matches: 1,
    });
    expect((await repository.getDraft(draft.id))?.preview).toEqual(draft.preview);
    const changed = await app.inject({
      method: 'PATCH',
      url: `/api/v2/collection-drafts/${draft.id}`,
      headers: { 'idempotency-key': 'invalid-draft', 'if-match': `"${draft.revision}"` },
      payload: {
        definition: { type: 'css', container: '[broken', fields: { name: { selector: 'h2' } } },
      },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    draft = changed.json<CollectionDraft>();
    expect(draft.preview).toBeNull();
    const committed = await app.inject({
      method: 'POST',
      url: `/api/v2/collection-drafts/${draft.id}/commit`,
      headers: { 'idempotency-key': 'invalid-commit', 'if-match': `"${draft.revision}"` },
      payload: { run: true },
    });
    expect(committed.statusCode).toBe(400);
    expect(committed.json().detail).toContain('Invalid css');
    expect(enqueue).not.toHaveBeenCalled();
    expect((await repository.getDraft(draft.id))?.status).toBe('editing');
  });

  it('refuses an ambiguous detail relationship while retaining the editable draft', async () => {
    const { app, repository, enqueue } = await fixture(undefined, async () => ({
      records: [
        {
          data: { name: 'fixture', url: 'http://fixture.invalid/detail', description: 'first' },
          sourceUrl: 'http://fixture.invalid',
          inspection: {
            fields: {
              name: { status: 'valid', matches: 1 },
              url: { status: 'valid', matches: 2 },
              description: { status: 'valid', matches: 1 },
            },
            containerHint: 'content',
            detail: { urlField: 'url', linkMatches: 2, recordMatches: 1, status: 'ambiguous_link' },
          },
        },
      ],
    }));
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/v2/collection-drafts',
        headers: { 'idempotency-key': 'ambiguous-draft' },
        payload: {},
      })
    ).json<CollectionDraft>();
    const definition = normalizeCrawlPlan({
      list: {
        rule: {
          type: 'css',
          container: 'article',
          fields: {
            name: { selector: 'h2' },
            url: { selector: 'a', value: 'attribute', attribute: 'href', dataType: 'url' },
          },
        },
      },
      detail: {
        urlField: 'url',
        rule: { type: 'css', container: 'main', fields: { description: { selector: 'p' } } },
      },
    });
    let draft = (
      await app.inject({
        method: 'PATCH',
        url: `/api/v2/collection-drafts/${created.id}`,
        headers: { 'idempotency-key': 'ambiguous-fields', 'if-match': `"${created.revision}"` },
        payload: {
          task: {
            startUrl: 'http://fixture.invalid',
            name: 'Ambiguous',
            instruction: 'Collect list and detail',
          },
          definition,
        },
      })
    ).json<CollectionDraft>();
    draft = (
      await app.inject({
        method: 'POST',
        url: `/api/v2/collection-drafts/${created.id}/preview`,
        headers: { 'idempotency-key': 'ambiguous-preview', 'if-match': `"${draft.revision}"` },
      })
    ).json<CollectionDraft>();
    const commit = await app.inject({
      method: 'POST',
      url: `/api/v2/collection-drafts/${draft.id}/commit`,
      headers: { 'idempotency-key': 'ambiguous-commit', 'if-match': `"${draft.revision}"` },
      payload: { run: true },
    });
    expect(commit.statusCode, commit.body).toBe(422);
    expect(commit.json().code).toBe('AMBIGUOUS_DETAIL_RELATION');
    expect(enqueue).not.toHaveBeenCalled();
    expect((await repository.getDraft(draft.id))?.status).toBe('editing');
  });
  it('binds login credentials to a draft once and cleans up unbound credentials on version conflicts', async () => {
    const login = vi.fn(async () => ({ reference: 'credential:new-session' }));
    const f = await fixture(login);
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/v2/collection-drafts',
      headers: { 'idempotency-key': 'login-draft' },
      payload: {},
    });
    const draft = created.json<CollectionDraft>();
    const updated = await f.repository.updateDraft(
      { ...draft, task: { ...draft.task, startUrl: 'https://example.com' } },
      draft.revision,
    );
    const request = () =>
      f.app.inject({
        method: 'POST',
        url: `/api/v2/collection-drafts/${draft.id}/browser-session/login`,
        headers: {
          'idempotency-key': 'same-login',
          'if-match': JSON.stringify(String(updated!.revision)),
        },
        payload: {},
      });
    const first = await request();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().draft.task.credentialBindings.browserStorageStateRef).toBe(
      'credential:new-session',
    );
    expect((await request()).json()).toEqual(first.json());
    expect(login).toHaveBeenCalledOnce();
    const current = await f.repository.getDraft(draft.id);
    login.mockImplementationOnce(async () => {
      await f.repository.updateDraft(
        { ...current!, task: { ...current!.task, instruction: 'concurrent change' } },
        current!.revision,
      );
      return { reference: 'credential:unbound' };
    });
    const conflict = await f.app.inject({
      method: 'POST',
      url: `/api/v2/collection-drafts/${draft.id}/browser-session/login`,
      headers: {
        'idempotency-key': 'conflicting-login',
        'if-match': JSON.stringify(String(current!.revision)),
      },
      payload: {},
    });
    expect(conflict.statusCode).toBe(412);
    expect(f.deleteCredential).toHaveBeenCalledWith('credential:unbound');
    expect(
      (await f.repository.getDraft(draft.id))?.task.credentialBindings?.browserStorageStateRef,
    ).toBe('credential:new-session');
  });

  it('supports canceled login and rejects automatic login when the host lacks that capability', async () => {
    for (const controlled of [true, false]) {
      const f = await fixture(controlled ? async () => ({ canceled: true }) : undefined);
      const created = (
        await f.app.inject({
          method: 'POST',
          url: '/api/v2/collection-drafts',
          headers: { 'idempotency-key': 'draft' },
          payload: {},
        })
      ).json<CollectionDraft>();
      const draft = await f.repository.updateDraft(
        { ...created, task: { ...created.task, startUrl: 'https://example.com' } },
        created.revision,
      );
      const response = await f.app.inject({
        method: 'POST',
        url: `/api/v2/collection-drafts/${created.id}/browser-session/login`,
        headers: {
          'idempotency-key': 'login',
          'if-match': JSON.stringify(String(draft!.revision)),
        },
        payload: {},
      });
      expect(response.statusCode).toBe(controlled ? 200 : 409);
      if (controlled) expect(response.json()).toEqual({ canceled: true });
      expect((await f.repository.getDraft(created.id))?.revision).toBe(draft!.revision);
    }
  });
  it('completes an offline example with stable preview and idempotent task/run identity', async () => {
    const { app, repository, platform, enqueue } = await fixture();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/examples/products/drafts',
      headers: { 'idempotency-key': 'example-entry' },
      payload: {},
    });
    expect(created.statusCode, created.body).toBe(201);
    let draft = created.json<CollectionDraft>();
    const concurrent = await Promise.all(
      Array.from({ length: 3 }, () =>
        app.inject({
          method: 'POST',
          url: '/api/v2/collection-drafts',
          headers: { 'idempotency-key': 'concurrent-create' },
          payload: {},
        }),
      ),
    );
    expect(concurrent.map((response) => response.statusCode)).toEqual([201, 201, 201]);
    expect(new Set(concurrent.map((response) => response.json<CollectionDraft>().id)).size).toBe(1);
    const repeated = await app.inject({
      method: 'POST',
      url: '/api/v2/examples/products/drafts',
      headers: { 'idempotency-key': 'example-entry' },
      payload: {},
    });
    expect(repeated.json<CollectionDraft>().id).toBe(draft.id);
    const preview = await app.inject({
      method: 'POST',
      url: `/api/v2/collection-drafts/${draft.id}/preview`,
      headers: { 'idempotency-key': 'preview', 'if-match': `"${draft.revision}"` },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    draft = preview.json<CollectionDraft>();
    expect(draft.preview?.records).toHaveLength(6);
    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/v2/collection-drafts/${draft.id}`,
      headers: { 'idempotency-key': crypto.randomUUID(), 'if-match': `"${draft.revision}"` },
      payload: { task: { name: 'Offline products' } },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    draft = renamed.json<CollectionDraft>();
    expect(draft.preview?.records, renamed.body).toHaveLength(6);
    const commitRequest = {
      method: 'POST' as const,
      url: `/api/v2/collection-drafts/${draft.id}/commit`,
      headers: { 'idempotency-key': 'submit', 'if-match': `"${draft.revision}"` },
      payload: { run: true },
    };
    const committed = await app.inject(commitRequest);
    expect(committed.statusCode, committed.body).toBe(200);
    const result = committed.json<CollectionDraft>();
    expect((await app.inject(commitRequest)).json<CollectionDraft>().result).toEqual(result.result);
    expect((await repository.listTasks()).items).toHaveLength(1);
    expect(await repository.listRuns(result.result!.taskId)).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const task = await repository.getTask(result.result!.taskId);
    expect(task?.origin).toEqual({ kind: 'example', exampleId: 'products' });
    expect(
      executeProductExample('products', task!.activeRule!.version.definition).records,
    ).toHaveLength(6);
    expect(await platform.listExperienceEvents()).toHaveLength(0);
  });
  it('rejects stale manual and AI edits, invalidates collection changes, and restores drafts after restart', async () => {
    const { app, repository, filePath } = await fixture();
    let draft = (
      await app.inject({
        method: 'POST',
        url: '/api/v2/examples/products/drafts',
        headers: { 'idempotency-key': 'conflict' },
        payload: {},
      })
    ).json<CollectionDraft>();
    draft = (
      await app.inject({
        method: 'POST',
        url: `/api/v2/collection-drafts/${draft.id}/preview`,
        headers: { 'idempotency-key': 'preview', 'if-match': '"1"' },
      })
    ).json<CollectionDraft>();
    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/v2/collection-drafts/${draft.id}`,
      headers: { 'idempotency-key': crypto.randomUUID(), 'if-match': '"1"' },
      payload: { actor: 'ai', task: { name: 'Lost edit' } },
    });
    expect(stale.statusCode).toBe(412);
    const forbidden = await app.inject({
      method: 'PATCH',
      url: `/api/v2/collection-drafts/${draft.id}`,
      headers: { 'idempotency-key': crypto.randomUUID(), 'if-match': `"${draft.revision}"` },
      payload: { actor: 'ai', task: { browserSettings: { enabled: true, actions: [] } } },
    });
    expect(forbidden.statusCode).toBe(400);
    const definition = structuredClone(draft.definition!);
    if (definition.list.rule.type === 'css') delete definition.list.rule.fields['库存'];
    const changed = await app.inject({
      method: 'PATCH',
      url: `/api/v2/collection-drafts/${draft.id}`,
      headers: { 'idempotency-key': crypto.randomUUID(), 'if-match': `"${draft.revision}"` },
      payload: { definition, step: 2 },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    draft = changed.json<CollectionDraft>();
    expect(draft.preview).toBeNull();
    expect((await repository.getDraft(draft.id))?.step).toBe(2);
    const reopened = new SqliteCollectionRepository(filePath);
    await reopened.migrate();
    try {
      expect(await reopened.getDraft(draft.id)).toEqual(draft);
    } finally {
      await reopened.close();
    }
    const commit = await app.inject({
      method: 'POST',
      url: `/api/v2/collection-drafts/${draft.id}/commit`,
      headers: { 'idempotency-key': 'unpreviewed', 'if-match': `"${draft.revision}"` },
      payload: { run: true },
    });
    expect(commit.statusCode).toBe(409);
    const arbitrary = await app.inject({
      method: 'POST',
      url: '/api/v2/examples/https%3A%2F%2Fevil.test/drafts',
      headers: { 'idempotency-key': 'invalid' },
      payload: {},
    });
    expect(arbitrary.statusCode).toBe(404);
  });
});
