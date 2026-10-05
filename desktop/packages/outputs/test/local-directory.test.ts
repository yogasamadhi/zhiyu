import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalDirectoryOutputAdapter, type OutputDestinationLike } from '../src/index.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function directory() {
  const value = await mkdtemp(join(tmpdir(), 'zhiyun-local-output-test-'));
  directories.push(value);
  return value;
}

function destination(config: Record<string, unknown>): OutputDestinationLike {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: 'Local directory fixture',
    type: 'local-directory',
    config,
    credentialRef: null,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

describe('Local directory output', () => {
  it('performs a real write/rename/delete connection test', async () => {
    const root = await directory();
    await new LocalDirectoryOutputAdapter().test({
      destination: destination({ taskSlug: 'products' }),
      credential: { directoryPath: root },
    });
    expect(await readdir(root)).toEqual([]);
  });

  it('publishes an immutable CSV archive and atomically updates latest', async () => {
    const root = await directory();
    const runId = crypto.randomUUID();
    const adapter = new LocalDirectoryOutputAdapter();
    const target = destination({ format: 'csv', taskSlug: 'products', latest: true });
    const input = {
      destination: target,
      taskId: crypto.randomUUID(),
      runId,
      datasetSettings: { mode: 'upsert' as const, keyFields: ['id'], detectRemoved: false },
      records: [
        { sourceUrl: 'https://example.com/1', data: { name: 'one', id: 1 } },
        { sourceUrl: 'https://example.com/2', data: { name: 'two, quoted', id: 2 } },
      ],
      credential: { directoryPath: root },
    };
    const result = await adapter.deliver(input);
    const now = new Date();
    const archive = join(
      root,
      'products',
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      `${runId}.csv`,
    );
    const latest = join(root, 'products', 'latest.csv');
    const expected =
      'id,name,_source_url\n1,one,https://example.com/1\n2,"two, quoted",https://example.com/2\n';
    expect(result).toMatchObject({
      responseStatus: null,
      delivered: 2,
      format: 'csv',
      finalLocation: archive,
      deliveredRecordCount: 2,
    });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(archive, 'utf8')).toBe(expected);
    expect(await readFile(latest, 'utf8')).toBe(expected);

    await expect(adapter.deliver({ ...input, records: input.records })).resolves.toMatchObject({
      delivered: 2,
    });
    await expect(
      adapter.deliver({
        ...input,
        records: [{ sourceUrl: 'https://example.com/1', data: { id: 1, name: 'changed' } }],
      }),
    ).rejects.toThrow('immutable output archive already exists with different content');
  });

  it('rejects traversal before touching the destination and reports Parquet handoff clearly', async () => {
    const root = await directory();
    const adapter = new LocalDirectoryOutputAdapter();
    await expect(
      adapter.test({
        destination: destination({ pathTemplate: '../{runId}.jsonl' }),
        credential: { directoryPath: root },
      }),
    ).rejects.toThrow('parent segments');
    await expect(
      adapter.deliver({
        destination: destination({ format: 'parquet', taskSlug: 'products' }),
        taskId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        datasetSettings: { mode: 'append', keyFields: [], detectRemoved: false },
        records: [],
        credential: { directoryPath: root },
      }),
    ).rejects.toThrow('artifact materialization support');
  });

  it('requires every immutable archive template to contain the run id', async () => {
    const root = await directory();
    await expect(
      new LocalDirectoryOutputAdapter().test({
        destination: destination({ pathTemplate: 'products/latest.jsonl' }),
        credential: { directoryPath: root },
      }),
    ).rejects.toThrow('must contain {runId}');
    expect(await readdir(root)).toEqual([]);
  });

  it('copies and verifies a large pre-materialized artifact with a streaming checksum', async () => {
    const root = await directory();
    const artifactPath = join(root, 'large-artifact.jsonl');
    const chunk = Buffer.alloc(1024 * 1024, 'z');
    const chunkCount = 32;
    const digest = createHash('sha256');
    const handle = await open(artifactPath, 'w', 0o600);
    try {
      for (let index = 0; index < chunkCount; index += 1) {
        await handle.write(chunk);
        digest.update(chunk);
      }
    } finally {
      await handle.close();
    }
    const sha256 = digest.digest('hex');
    const runId = crypto.randomUUID();
    const result = await new LocalDirectoryOutputAdapter().deliver({
      destination: destination({
        format: 'jsonl',
        taskSlug: 'large-fixture',
        pathTemplate: '{taskSlug}/{runId}.{ext}',
        latest: false,
      }),
      taskId: crypto.randomUUID(),
      runId,
      datasetSettings: { mode: 'append', keyFields: [], detectRemoved: false },
      records: [],
      artifact: {
        id: 'a'.repeat(64),
        path: artifactPath,
        format: 'jsonl',
        delivered: 100_000,
        sha256,
        bytes: chunk.length * chunkCount,
        fields: ['value'],
      },
      credential: { directoryPath: root },
    });

    expect(result).toMatchObject({
      delivered: 100_000,
      deliveredRecordCount: 100_000,
      sha256,
    });
    expect((await stat(join(root, 'large-fixture', `${runId}.jsonl`))).size).toBe(
      chunk.length * chunkCount,
    );
  });
});
