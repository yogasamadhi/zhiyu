import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileOutputArtifactStore,
  outputArtifactId,
  type OutputArtifactSpec,
} from '../src/index.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe.each(['csv', 'jsonl'] as const)('%s output artifact materialization', (format) => {
  it('reuses the atomically published bytes without iterating records again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zhiyun-output-artifact-test-'));
    directories.push(root);
    const store = new FileOutputArtifactStore(root);
    const spec: OutputArtifactSpec = {
      format,
      fields: ['id', 'title'],
      includeSourceUrl: true,
      fingerprint: `${format}-fixture`,
    };
    const id = outputArtifactId(crypto.randomUUID(), spec);
    let deliveredBySource = 0;
    const records = async function* () {
      deliveredBySource += 1;
      yield { sourceUrl: 'https://example.com/1', data: { id: 1, title: 'One' } };
      deliveredBySource += 1;
      yield { sourceUrl: 'https://example.com/2', data: { id: 2, title: 'Two' } };
    };
    const first = await store.materialize({ id, spec, records: records() });
    const second = await store.materialize({
      id,
      spec,
      records: (async function* () {
        yield* [];
        throw new Error('cached materialization must not read the dataset');
      })(),
    });

    expect(second).toEqual(first);
    expect(deliveredBySource).toBe(2);
    expect(first).toMatchObject({ id, format, delivered: 2 });
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    const content = await readFile(first.path, 'utf8');
    expect(content).toContain('One');
    expect(content).toContain('Two');
  });
});

describe('CSV field discovery', () => {
  it('spools the stream and includes fields first seen in later records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zhiyun-output-artifact-fields-'));
    directories.push(root);
    const spec: OutputArtifactSpec = {
      format: 'csv',
      fields: [],
      includeSourceUrl: false,
      fingerprint: 'field-discovery',
    };
    const artifact = await new FileOutputArtifactStore(root).materialize({
      id: outputArtifactId(crypto.randomUUID(), spec),
      spec,
      records: (async function* () {
        yield { sourceUrl: 'https://example.com/1', data: { first: 1 } };
        yield { sourceUrl: 'https://example.com/2', data: { second: 2 } };
      })(),
    });
    expect(artifact.fields).toEqual(['first', 'second']);
    expect(await readFile(artifact.path, 'utf8')).toBe('first,second\n1,\n,2\n');
  });
});
