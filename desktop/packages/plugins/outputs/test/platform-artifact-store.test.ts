import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AnalyticsWorkerClient, AnalyticsWorkerSupervisor } from '@zhiyun/analytics-worker-client';
import { LocalArtifactStore } from '@zhiyun/artifact-store';
import {
  LocalDirectoryOutputAdapter,
  S3OutputAdapter,
  type S3PutInput,
  type S3Transport,
} from '@zhiyun/outputs';
import { PlatformOutputArtifactStore } from '../src/index.js';

const directories: string[] = [];
const workspaceRoot = resolve(import.meta.dirname, '../../../..');
const python =
  process.platform === 'win32'
    ? join(workspaceRoot, 'analytics-worker', '.venv', 'Scripts', 'python.exe')
    : join(workspaceRoot, 'analytics-worker', '.venv', 'bin', 'python');

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('PlatformOutputArtifactStore', () => {
  it('commits a materialization to ArtifactStore and reuses it without scanning records again', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zhiyun-platform-output-artifact-'));
    directories.push(directory);
    const platformArtifacts = new LocalArtifactStore(directory);
    await platformArtifacts.initialize();
    const artifacts = new PlatformOutputArtifactStore(platformArtifacts);
    const id = 'a'.repeat(64);
    const spec = {
      format: 'jsonl' as const,
      fields: ['id'],
      includeSourceUrl: true,
      fingerprint: 'b'.repeat(64),
    };
    const first = await artifacts.materialize({
      id,
      spec,
      records: [{ sourceUrl: 'https://example.com/1', data: { id: 1 } }],
    });
    const second = await new PlatformOutputArtifactStore(platformArtifacts).materialize({
      id,
      spec,
      records: recordsThatThrow('cached platform artifact must not read records'),
    });

    expect(second).toEqual(first);
    expect(first.path).toContain('/artifacts/outputs/');
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/u);
    await platformArtifacts.close();
  });

  it('fails Parquet explicitly before reading records when the Worker is unavailable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zhiyun-platform-output-artifact-'));
    directories.push(directory);
    const platformArtifacts = new LocalArtifactStore(directory);
    await platformArtifacts.initialize();
    let reads = 0;
    await expect(
      new PlatformOutputArtifactStore(platformArtifacts).materialize({
        id: 'c'.repeat(64),
        spec: {
          format: 'parquet',
          fields: [],
          includeSourceUrl: true,
          fingerprint: 'd'.repeat(64),
        },
        records: (async function* () {
          reads += 1;
          yield { sourceUrl: 'https://example.com/1', data: { id: 1 } };
        })(),
      }),
    ).rejects.toThrow(
      'ANALYTICS_UNAVAILABLE: Parquet output requires an available Analytics Worker',
    );
    expect(reads).toBe(0);
    await platformArtifacts.close();
  });
});

describe.skipIf(!existsSync(python))(
  'PlatformOutputArtifactStore Parquet Worker integration',
  () => {
    it('streams one run through dataset.normalize_snapshot and reuses the controlled artifact', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'zhiyun-platform-parquet-artifact-'));
      directories.push(directory);
      const platformArtifacts = new LocalArtifactStore(directory);
      await platformArtifacts.initialize();
      const supervisor = new AnalyticsWorkerSupervisor({
        command: python,
        args: ['-m', 'zhiyun_analytics_worker'],
        workspaceRoot: join(directory, 'job-workspaces'),
      });
      try {
        const client = new AnalyticsWorkerClient(await supervisor.start());
        const worker = {
          available: () => true,
          submit: (input: Parameters<AnalyticsWorkerClient['submit']>[0]) => client.submit(input),
          job: (jobId: string) => client.job(jobId),
          cancel: (jobId: string) => client.cancel(jobId),
        };
        let reads = 0;
        const id = 'e'.repeat(64);
        const spec = {
          format: 'parquet' as const,
          fields: ['id', 'score'],
          includeSourceUrl: true,
          fingerprint: 'f'.repeat(64),
        };
        const artifact = await new PlatformOutputArtifactStore(platformArtifacts, {
          parquetWorker: worker,
          pollIntervalMs: 10,
          timeoutMs: 30_000,
        }).materialize({
          id,
          spec,
          records: (async function* () {
            reads += 1;
            yield {
              sourceUrl: 'https://example.com/1',
              data: { id: 1, score: 10, ignored: 'not exported' },
            };
            reads += 1;
            yield {
              sourceUrl: 'https://example.com/2',
              data: { id: 2, score: 12.5, ignored: 'not exported' },
            };
          })(),
        });

        const bytes = await readFile(artifact.path);
        expect(bytes.subarray(0, 4).toString('ascii')).toBe('PAR1');
        expect(bytes.subarray(-4).toString('ascii')).toBe('PAR1');
        expect(artifact).toMatchObject({
          id,
          format: 'parquet',
          delivered: 2,
          fields: ['id', 'score', '_source_url'],
        });
        expect(reads).toBe(2);
        const manifest = JSON.parse(
          await readFile(
            await platformArtifacts.resolveArtifact(`outputs/${id}.schema-manifest.json`),
            'utf8',
          ),
        ) as { rowCount: number; columns: Array<{ sourceField: string }> };
        expect(manifest.rowCount).toBe(2);
        expect(manifest.columns.map(({ sourceField }) => sourceField)).toEqual(['id', 'score']);

        const now = new Date().toISOString();
        const taskId = crypto.randomUUID();
        const runId = crypto.randomUUID();
        const outputRoot = join(directory, 'published');
        const localResult = await new LocalDirectoryOutputAdapter().deliver({
          destination: {
            id: crypto.randomUUID(),
            name: 'Parquet directory',
            type: 'local-directory',
            config: {
              format: 'parquet',
              taskSlug: 'products',
              pathTemplate: 'products/{runId}.{ext}',
              latest: false,
            },
            credentialRef: null,
            enabled: true,
            createdAt: now,
            updatedAt: now,
          },
          taskId,
          runId,
          datasetSettings: { mode: 'snapshot', keyFields: [], detectRemoved: true },
          records: recordsMustNotBeRead(),
          credential: { directoryPath: outputRoot },
          artifact,
        });
        expect(localResult.finalLocation).toBe(join(outputRoot, 'products', `${runId}.parquet`));
        expect((await readFile(localResult.finalLocation!)).subarray(0, 4).toString('ascii')).toBe(
          'PAR1',
        );

        let uploaded: Buffer | undefined;
        let uploadedContentType: string | undefined;
        const transport: S3Transport = {
          testBucket: async () => undefined,
          headObject: async () => null,
          putObject: async (input: S3PutInput) => {
            uploaded = await readFile(input.bodyPath);
            uploadedContentType = input.contentType;
          },
          deleteObject: async () => undefined,
        };
        const s3Result = await new S3OutputAdapter({ transport }).deliver({
          destination: {
            id: crypto.randomUUID(),
            name: 'Parquet S3',
            type: 's3',
            config: {
              bucket: 'fixture-bucket',
              region: 'us-east-1',
              format: 'parquet',
              taskSlug: 'products',
              pathTemplate: 'products/{runId}.{ext}',
              latest: false,
            },
            credentialRef: null,
            enabled: true,
            createdAt: now,
            updatedAt: now,
          },
          taskId,
          runId,
          datasetSettings: { mode: 'snapshot', keyFields: [], detectRemoved: true },
          records: recordsMustNotBeRead(),
          credential: null,
          artifact,
        });
        expect(s3Result).toMatchObject({
          artifactId: artifact.id,
          sha256: artifact.sha256,
          deliveredRecordCount: 2,
        });
        expect(uploaded?.subarray(0, 4).toString('ascii')).toBe('PAR1');
        expect(uploadedContentType).toBe('application/vnd.apache.parquet');

        const reused = await new PlatformOutputArtifactStore(platformArtifacts).materialize({
          id,
          spec,
          records: recordsThatThrow('a retry must reuse Parquet without scanning the run again'),
        });
        expect(reused).toEqual(artifact);
        expect(reads).toBe(2);
      } finally {
        await supervisor.stop();
        await platformArtifacts.close();
      }
    }, 45_000);
  },
);

async function* recordsMustNotBeRead(): AsyncGenerator<never> {
  yield* recordsThatThrow('artifact-backed delivery must not scan run records');
}

async function* recordsThatThrow(message: string): AsyncGenerator<never> {
  for (const value of [] as never[]) yield value;
  throw new Error(message);
}
