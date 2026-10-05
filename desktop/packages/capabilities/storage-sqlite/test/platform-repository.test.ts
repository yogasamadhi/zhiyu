import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { definePlatformRepositoryConformance } from '@zhiyun/platform-testkit';
import { openSqlitePlatformRepository, prepareSqliteV1 } from '../src/index.js';

definePlatformRepositoryConformance({
  name: 'SQLite',
  async create() {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'zhiyun-platform-sqlite-'));
    const repository = await openSqlitePlatformRepository({
      dataDirectory,
      filePath: join(dataDirectory, 'zhiyun.sqlite3'),
      graphRevision: 'test-revision',
    });
    return {
      repository,
      async dispose() {
        await repository.close();
        await rm(dataDirectory, { recursive: true, force: true });
      },
    };
  },
});

it('removes Artifact descriptors only for the matching plugin owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zhiyun-artifact-owner-'));
  const repository = await openSqlitePlatformRepository({
    dataDirectory: directory,
    filePath: join(directory, 'zhiyun.sqlite3'),
    graphRevision: 'artifact-owner-test',
  });
  try {
    const artifact = await repository.createArtifact({
      ownerPluginId: 'datasets',
      kind: 'dataset.cleaning.report',
      filename: 'report.json',
      contentType: 'application/json',
      size: 2,
      checksum: 'a'.repeat(64),
      storageKey: 'dataset-cleaning/fixture/report.json',
      metadata: {},
    });
    expect(await repository.removeArtifact(artifact.id, 'outputs')).toBe(false);
    expect(await repository.getArtifact(artifact.id)).toEqual(artifact);
    expect(await repository.removeArtifact(artifact.id, 'datasets')).toBe(true);
    expect(await repository.getArtifact(artifact.id)).toBeNull();
  } finally {
    await repository.close();
    await rm(directory, { recursive: true, force: true });
  }
});

describe('SQLite durable completion recovery', () => {
  it('scopes terminal recovery by identity and attempt and refuses active, stale or canceled jobs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zhiyun-completion-job-'));
    const repository = await openSqlitePlatformRepository({
      dataDirectory: directory,
      filePath: join(directory, 'zhiyun.sqlite3'),
      graphRevision: 'completion-test',
    });
    try {
      const job = await repository.enqueueJob({
        ownerPluginId: 'collection',
        type: 'collection.crawl.execute',
        resourceClass: 'browser-heavy',
        payload: { taskId: 'fixture-task', runId: 'fixture-run' },
        maxAttempts: 1,
      });
      const other = await repository.enqueueJob({
        ownerPluginId: 'outputs',
        type: 'outputs.deliver',
        resourceClass: 'delivery',
        payload: {},
        maxAttempts: 1,
      });
      await repository.claimJob({
        jobId: job.id,
        workerId: 'completion-worker',
        resourceClasses: ['browser-heavy'],
        leaseMs: 1_000,
      });
      const running = (await repository.startJob(job.id, 'completion-worker', 1_000))!;
      await expect(repository.retryJobCompletion(running)).resolves.toBeNull();
      const failed = (await repository.failJob(job.id, 'completion-worker', {
        code: 'JOB_INTERRUPTED',
        message: 'fixture',
        retryable: false,
      }))!;
      for (const input of [
        { ...failed, ownerPluginId: 'outputs' },
        { ...failed, type: 'outputs.deliver' },
        { ...failed, payload: { taskId: 'other-task', runId: 'fixture-run' } },
        { ...failed, attempt: 0 },
      ])
        await expect(repository.retryJobCompletion(input)).resolves.toBeNull();
      expect(await repository.getJob(job.id)).toMatchObject({
        state: 'failed',
        attempt: 1,
        maxAttempts: 1,
      });
      const recovered = (await repository.retryJobCompletion(failed))!;
      expect(recovered).toMatchObject({
        state: 'queued',
        phase: 'recovering-completion',
        attempt: 1,
        maxAttempts: 2,
        payload: job.payload,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      expect(Date.parse(recovered.availableAt)).toBeGreaterThan(Date.now());
      await expect(repository.retryJobCompletion(failed)).resolves.toBeNull();
      expect(await repository.getJob(other.id)).toEqual(other);
      const canceled = await repository.enqueueJob({
        ownerPluginId: 'collection',
        type: job.type,
        resourceClass: 'browser-heavy',
        payload: job.payload,
        maxAttempts: 1,
      });
      await repository.claimJob({
        jobId: canceled.id,
        workerId: 'completion-worker',
        resourceClasses: ['browser-heavy'],
        leaseMs: 1_000,
      });
      await repository.startJob(canceled.id, 'completion-worker', 1_000);
      await repository.requestJobCancel(canceled.id);
      const canceledFailure = (await repository.failJob(canceled.id, 'completion-worker', {
        code: 'CANCELED',
        message: 'fixture',
        retryable: false,
      }))!;
      expect(canceledFailure.cancelRequestedAt).toBeTruthy();
      await expect(repository.retryJobCompletion(canceledFailure)).resolves.toBeNull();
    } finally {
      await repository.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('SQLite 1.0 destructive reset', () => {
  it('removes only the known legacy database and controlled data directories', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'zhiyun-reset-'));
    const filePath = join(dataDirectory, 'zhiyun.sqlite3');
    const legacy = new Database(filePath);
    legacy.exec(
      'CREATE TABLE tasks(id TEXT); CREATE TABLE rules(id TEXT); CREATE TABLE runs(id TEXT); CREATE TABLE records(id TEXT);',
    );
    legacy.close();
    for (const directory of ['artifacts', 'credentials', 'job-workspaces']) {
      await mkdir(join(dataDirectory, directory));
      await writeFile(join(dataDirectory, directory, 'legacy.txt'), 'legacy');
    }
    await writeFile(join(dataDirectory, 'unrelated.txt'), 'keep');

    const repository = await openSqlitePlatformRepository({
      dataDirectory,
      filePath,
      graphRevision: 'after-reset',
    });
    await repository.close();

    expect(await readFile(join(dataDirectory, 'unrelated.txt'), 'utf8')).toBe('keep');
    const current = new Database(filePath, { readonly: true });
    expect(() => current.prepare('SELECT * FROM tasks')).toThrow();
    expect(
      current.prepare('SELECT product_schema_version FROM zhiyun_meta WHERE id=1').get(),
    ).toEqual({ product_schema_version: '1.0.0' });
    current.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  it('refuses an unknown schema without deleting it', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'zhiyun-unknown-'));
    const filePath = join(dataDirectory, 'zhiyun.sqlite3');
    const unknown = new Database(filePath);
    unknown.exec(
      "CREATE TABLE customer_data(value TEXT); INSERT INTO customer_data VALUES ('keep')",
    );
    unknown.close();

    await expect(prepareSqliteV1({ dataDirectory, filePath })).rejects.toThrow(
      'Unknown SQLite schema',
    );
    const preserved = new Database(filePath, { readonly: true });
    expect(preserved.prepare('SELECT value FROM customer_data').get()).toEqual({ value: 'keep' });
    preserved.close();
    await rm(dataDirectory, { recursive: true, force: true });
  });

  it('rejects an unexpected database filename and symlink escape before deletion', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'zhiyun-path-'));
    await expect(
      prepareSqliteV1({ dataDirectory, filePath: join(dataDirectory, 'other.sqlite3') }),
    ).rejects.toThrow('direct userData/zhiyun.sqlite3');

    const outside = await mkdtemp(join(tmpdir(), 'zhiyun-outside-'));
    const filePath = join(dataDirectory, 'zhiyun.sqlite3');
    const legacy = new Database(filePath);
    legacy.exec(
      'CREATE TABLE tasks(id TEXT); CREATE TABLE rules(id TEXT); CREATE TABLE runs(id TEXT); CREATE TABLE records(id TEXT);',
    );
    legacy.close();
    await symlink(outside, join(dataDirectory, 'artifacts'));
    await expect(prepareSqliteV1({ dataDirectory, filePath })).rejects.toThrow(
      'Refusing uncontrolled reset target',
    );
    expect(await readFile(filePath)).not.toHaveLength(0);
    await rm(dataDirectory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it('continues an interrupted reset marker but never lets it authorize an unknown schema', async () => {
    const recoverDirectory = await mkdtemp(join(tmpdir(), 'zhiyun-marker-recover-'));
    await writeFile(
      join(recoverDirectory, '.zhiyun-v1-resetting'),
      '{"operation":"legacy-to-1.0","version":1}\n',
    );
    const recovered = await openSqlitePlatformRepository({
      dataDirectory: recoverDirectory,
      filePath: join(recoverDirectory, 'zhiyun.sqlite3'),
      graphRevision: 'recovered',
    });
    await recovered.close();
    await expect(
      readFile(join(recoverDirectory, '.zhiyun-v1-resetting'), 'utf8'),
    ).rejects.toThrow();
    await rm(recoverDirectory, { recursive: true, force: true });

    const unknownDirectory = await mkdtemp(join(tmpdir(), 'zhiyun-marker-unknown-'));
    const unknownPath = join(unknownDirectory, 'zhiyun.sqlite3');
    const unknown = new Database(unknownPath);
    unknown.exec('CREATE TABLE customer_data(value TEXT)');
    unknown.close();
    await writeFile(
      join(unknownDirectory, '.zhiyun-v1-resetting'),
      '{"operation":"legacy-to-1.0","version":1}\n',
    );
    await expect(
      prepareSqliteV1({ dataDirectory: unknownDirectory, filePath: unknownPath }),
    ).rejects.toThrow('Unknown SQLite schema during reset recovery');
    const preserved = new Database(unknownPath, { readonly: true });
    expect(preserved.prepare('SELECT 1 FROM customer_data')).toBeDefined();
    preserved.close();
    await rm(unknownDirectory, { recursive: true, force: true });
  });

  it('refuses migration checksum drift', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'zhiyun-checksum-'));
    const filePath = join(dataDirectory, 'zhiyun.sqlite3');
    const repository = await openSqlitePlatformRepository({
      dataDirectory,
      filePath,
      graphRevision: 'checksum-test',
    });
    await repository.close();
    const tamper = new Database(filePath);
    tamper.prepare("UPDATE plugin_migrations SET checksum='tampered'").run();
    tamper.close();
    await expect(
      openSqlitePlatformRepository({ dataDirectory, filePath, graphRevision: 'must-fail' }),
    ).rejects.toThrow('Migration checksum mismatch');
    await rm(dataDirectory, { recursive: true, force: true });
  });
});
