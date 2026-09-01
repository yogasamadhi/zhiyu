import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FileOutputArtifactStore,
  S3OutputAdapter,
  outputArtifactId,
  outputArtifactSpec,
  type OutputDestinationLike,
  type S3ObjectMetadata,
  type S3PutInput,
  type S3Transport,
} from '../src/index.js';

function destination(config: Record<string, unknown>): OutputDestinationLike {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: 'S3 fixture',
    type: 's3',
    config: { bucket: 'zhiyun-fixture', region: 'us-east-1', ...config },
    credentialRef: 'credential:test',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

class MemoryTransport implements S3Transport {
  tested = 0;
  deleted: string[] = [];
  puts: Array<S3PutInput & { body: string }> = [];
  objects = new Map<string, S3ObjectMetadata>();
  multipartPartCounts: number[] = [];
  visitedParts: number[] = [];
  abortedUploads = 0;
  onPart?: (part: number) => void;

  async testBucket() {
    this.tested += 1;
  }

  async headObject(key: string) {
    return this.objects.get(key) ?? null;
  }

  async putObject(input: S3PutInput) {
    const body = await readFile(input.bodyPath);
    const partSize = 8 * 1_024 * 1_024;
    let parts = 0;
    for (let offset = 0; offset < body.length; offset += partSize) {
      if (input.signal?.aborted) {
        this.abortedUploads += 1;
        throw input.signal.reason ?? new Error('S3 upload aborted');
      }
      parts += 1;
      this.visitedParts.push(parts);
      this.onPart?.(parts);
    }
    if (input.signal?.aborted) {
      this.abortedUploads += 1;
      throw input.signal.reason ?? new Error('S3 upload aborted');
    }
    this.multipartPartCounts.push(parts);
    this.puts.push({ ...input, body: body.toString('utf8') });
    const objectSha = input.metadata.sha256;
    const runId = input.metadata['zhiyun-run-id'];
    this.objects.set(input.key, {
      ...(objectSha ? { sha256: objectSha } : {}),
      ...(runId ? { runId } : {}),
    });
  }

  async deleteObject(key: string) {
    this.deleted.push(key);
    this.objects.delete(key);
  }
}

describe('S3 output', () => {
  it('performs bucket, write and delete checks in the connection test', async () => {
    const transport = new MemoryTransport();
    await new S3OutputAdapter({ transport }).test({
      destination: destination({ prefix: 'exports' }),
      credential: null,
    });
    expect(transport.tested).toBe(1);
    expect(transport.puts).toHaveLength(1);
    expect(transport.puts[0]?.key).toMatch(/^exports\/\.zhiyun-test\//);
    expect(transport.deleted).toEqual([transport.puts[0]?.key]);
  });

  it('publishes archive before latest and skips an identical retry', async () => {
    const transport = new MemoryTransport();
    const adapter = new S3OutputAdapter({ transport });
    const runId = crypto.randomUUID();
    const target = destination({ format: 'jsonl', prefix: 'exports', taskSlug: 'products' });
    const input = {
      destination: target,
      taskId: crypto.randomUUID(),
      runId,
      datasetSettings: { mode: 'append' as const, keyFields: [], detectRemoved: false },
      records: [{ sourceUrl: 'https://example.com/1', data: { id: 1 } }],
      credential: null,
    };
    const result = await adapter.deliver(input);
    expect(result).toMatchObject({
      responseStatus: 200,
      delivered: 1,
      format: 'jsonl',
      deliveredRecordCount: 1,
    });
    expect(result.finalLocation).toMatch(
      new RegExp(`^exports/products/\\d{4}/\\d{2}/${input.runId}\\.jsonl$`),
    );
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(transport.puts).toHaveLength(2);
    expect(transport.puts[0]?.key).toMatch(
      new RegExp(`^exports/products/\\d{4}/\\d{2}/${runId}\\.jsonl$`),
    );
    expect(transport.puts[1]?.key).toBe('exports/products/latest.jsonl');
    expect(transport.puts[0]?.body).toBe('{"id":1,"_source_url":"https://example.com/1"}\n');

    await adapter.deliver({ ...input, records: input.records });
    expect(transport.puts).toHaveLength(2);
  });

  it('uploads a reusable artifact without iterating the run records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zhiyun-s3-artifact-test-'));
    try {
      const transport = new MemoryTransport();
      const adapter = new S3OutputAdapter({ transport });
      const runId = crypto.randomUUID();
      const target = destination({
        format: 'csv',
        prefix: 'exports',
        taskSlug: 'products',
        latest: false,
      });
      const spec = outputArtifactSpec(target);
      if (!spec) throw new Error('Expected an S3 artifact specification');
      const artifact = await new FileOutputArtifactStore(root).materialize({
        id: outputArtifactId(runId, spec),
        spec,
        records: [{ sourceUrl: 'https://example.com/1', data: { id: 1 } }],
      });
      const result = await adapter.deliver({
        destination: target,
        taskId: crypto.randomUUID(),
        runId,
        datasetSettings: { mode: 'append', keyFields: [], detectRemoved: false },
        records: (async function* () {
          yield* [];
          throw new Error('artifact-backed delivery must not iterate records');
        })(),
        credential: null,
        artifact,
      });

      expect(result).toMatchObject({
        artifactId: artifact.id,
        sha256: artifact.sha256,
        deliveredRecordCount: 1,
      });
      expect(transport.puts).toHaveLength(1);
      expect(transport.puts[0]?.body).toContain('id,_source_url');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('propagates cancellation during a multipart upload and never advances latest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zhiyun-s3-multipart-test-'));
    try {
      const path = join(root, 'large.jsonl');
      const body = Buffer.alloc(9 * 1_024 * 1_024, 0x61);
      await writeFile(path, body);
      const runId = crypto.randomUUID();
      const target = destination({
        format: 'jsonl',
        taskSlug: 'products',
        pathTemplate: 'products/{runId}.jsonl',
        latest: true,
      });
      const artifact = {
        id: 'a'.repeat(64),
        path,
        format: 'jsonl' as const,
        delivered: 1,
        sha256: createHash('sha256').update(body).digest('hex'),
        bytes: body.length,
        fields: ['value'],
      };
      const successful = new MemoryTransport();
      await new S3OutputAdapter({ transport: successful }).deliver({
        destination: target,
        taskId: crypto.randomUUID(),
        runId,
        datasetSettings: { mode: 'append', keyFields: [], detectRemoved: false },
        records: [],
        credential: null,
        artifact,
      });
      expect(successful.multipartPartCounts).toEqual([2, 2]);
      expect(successful.puts.map(({ key }) => key)).toEqual([
        `products/${runId}.jsonl`,
        'products/latest.jsonl',
      ]);

      const transport = new MemoryTransport();
      const controller = new AbortController();
      transport.onPart = (part) => {
        if (part === 1) controller.abort(new Error('fixture cancellation'));
      };
      await expect(
        new S3OutputAdapter({ transport }).deliver({
          destination: target,
          taskId: crypto.randomUUID(),
          runId,
          datasetSettings: { mode: 'append', keyFields: [], detectRemoved: false },
          records: [],
          credential: null,
          artifact,
          signal: controller.signal,
        }),
      ).rejects.toThrow('fixture cancellation');
      expect(transport.abortedUploads).toBe(1);
      expect(transport.visitedParts).toEqual([1]);
      expect(transport.puts).toHaveLength(0);
      expect(transport.objects.size).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects traversal and conflicting immutable objects', async () => {
    const transport = new MemoryTransport();
    const adapter = new S3OutputAdapter({ transport });
    await expect(
      adapter.test({
        destination: destination({ pathTemplate: '../{runId}.jsonl' }),
        credential: null,
      }),
    ).rejects.toThrow('parent segments');

    const runId = crypto.randomUUID();
    const target = destination({
      taskSlug: 'products',
      latest: false,
      pathTemplate: 'products/{runId}.jsonl',
    });
    transport.objects.set(`products/${runId}.jsonl`, {
      sha256: 'different',
      runId,
    });
    await expect(
      adapter.deliver({
        destination: target,
        taskId: crypto.randomUUID(),
        runId,
        datasetSettings: { mode: 'append', keyFields: [], detectRemoved: false },
        records: [{ sourceUrl: 'https://example.com', data: { id: 1 } }],
        credential: null,
      }),
    ).rejects.toThrow('different runId or sha256 metadata');

    await expect(
      adapter.test({
        destination: destination({ pathTemplate: 'products/latest.jsonl' }),
        credential: null,
      }),
    ).rejects.toThrow('must contain {runId}');

    const matchingTarget = destination({
      taskSlug: 'products',
      latest: false,
      pathTemplate: 'matching/{runId}.jsonl',
    });
    const matchingKey = `matching/${runId}.jsonl`;
    const digestRoot = await mkdtemp(join(tmpdir(), 'zhiyun-s3-metadata-test-'));
    try {
      const spec = outputArtifactSpec(matchingTarget)!;
      const artifact = await new FileOutputArtifactStore(digestRoot).materialize({
        id: outputArtifactId(runId, spec),
        spec,
        records: [{ sourceUrl: 'https://example.com', data: { id: 1 } }],
      });
      transport.objects.set(matchingKey, {
        sha256: artifact.sha256,
        runId: crypto.randomUUID(),
      });
      await expect(
        adapter.deliver({
          destination: matchingTarget,
          taskId: crypto.randomUUID(),
          runId,
          datasetSettings: { mode: 'append', keyFields: [], detectRemoved: false },
          records: [],
          credential: null,
          artifact,
        }),
      ).rejects.toThrow('different runId or sha256 metadata');
    } finally {
      await rm(digestRoot, { recursive: true, force: true });
    }
  });
});
