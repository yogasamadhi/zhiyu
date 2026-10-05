import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordExperience, type PlatformRepository } from '@zhiyun/platform-core';

export interface PlatformRepositoryFixture {
  repository: PlatformRepository;
  dispose(): Promise<void>;
}

export function definePlatformRepositoryConformance(input: {
  name: string;
  create(): Promise<PlatformRepositoryFixture>;
}): void {
  describe(`${input.name} platform repository conformance`, () => {
    let fixture: PlatformRepositoryFixture;

    beforeAll(async () => {
      fixture = await input.create();
    });

    afterAll(async () => {
      if (fixture) await fixture.dispose();
    });

    it('records the forward-only platform migration', async () => {
      const migrations = await fixture.repository.listMigrations();
      expect(migrations).toHaveLength(3);
      expect(migrations.map((migration) => migration.migrationId)).toEqual([
        '001-initial',
        '002-local-experience',
        '003-assistant-experience',
      ]);
      expect(migrations[0]).toMatchObject({
        pluginId: 'platform',
        migrationId: '001-initial',
        pluginVersion: '1.0.0',
        result: 'succeeded',
      });
      expect(migrations[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);
    });

    it('keeps workspace identity and private local metrics with deduplication, retention, opt-out and compare-and-set', async () => {
      const repo = fixture.repository;
      const ids = await Promise.all(Array.from({ length: 6 }, () => repo.getOrCreateWorkspaceId()));
      expect(new Set(ids).size).toBe(1);
      await repo.initialize('test-graph');
      expect(await repo.getOrCreateWorkspaceId()).toBe(ids[0]);
      await repo.clearExperienceEvents();
      const input = { id: 'run-event', type: 'run_succeeded' as const, taskId: 'anonymous-task' };
      await Promise.all([recordExperience(repo, input), recordExperience(repo, input)]);
      await recordExperience(repo, { ...input, id: 'example', example: true });
      const events = await repo.listExperienceEvents();
      expect(events).toHaveLength(1);
      expect(events[0]?.correlationId).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(events)).not.toContain('anonymous-task');
      expect(Object.keys(events[0]!).sort()).toEqual([
        'correlationId',
        'durationMs',
        'id',
        'occurredAt',
        'outcome',
        'type',
      ]);
      await repo.recordExperienceEvent({
        ...events[0]!,
        id: 'expired',
        occurredAt: new Date(Date.now() - 91 * 86400000).toISOString(),
      });
      expect(await repo.listExperienceEvents()).toHaveLength(1);
      expect(await repo.compareRuntimeSetting('experience.config', 1, { enabled: false })).toBe(
        true,
      );
      expect(await repo.compareRuntimeSetting('experience.config', 1, { enabled: true })).toBe(
        false,
      );
      await recordExperience(repo, { ...input, id: 'opted-out' });
      expect(await repo.listExperienceEvents()).toHaveLength(1);
      await repo.clearExperienceEvents();
      expect(await repo.listExperienceEvents()).toEqual([]);
      expect(await repo.compareRuntimeSetting('experience.config', 2, { enabled: true })).toBe(
        true,
      );
    });

    it('claims and completes typed jobs with guarded state transitions', async () => {
      const job = await fixture.repository.enqueueJob({
        ownerPluginId: 'analytics',
        type: 'analysis.execute',
        payload: { snapshotId: 'snapshot-1' },
        resourceClass: 'python-heavy',
        maxAttempts: 2,
      });
      expect(job).toMatchObject({ state: 'queued', attempt: 0, progress: 0 });
      const claimed = await fixture.repository.claimJob({
        workerId: 'worker-a',
        resourceClasses: ['python-heavy'],
        leaseMs: 30_000,
      });
      expect(claimed).toMatchObject({ id: job.id, state: 'claimed', attempt: 1 });
      await expect(fixture.repository.startJob(job.id, 'wrong-worker', 30_000)).resolves.toBeNull();
      expect(await fixture.repository.startJob(job.id, 'worker-a', 30_000)).toMatchObject({
        state: 'running',
      });
      expect(
        await fixture.repository.updateJobProgress(job.id, 'worker-a', 0.45, 'computing'),
      ).toMatchObject({ progress: 0.45, phase: 'computing' });
      expect(await fixture.repository.markJobPersisting(job.id, 'worker-a')).toMatchObject({
        state: 'persisting',
      });
      expect(await fixture.repository.completeJob(job.id, 'worker-a')).toMatchObject({
        state: 'succeeded',
        progress: 1,
        leaseOwner: null,
      });
      await expect(fixture.repository.completeJob(job.id, 'worker-a')).resolves.toBeNull();
    });

    it('supports cancellation, retry policy and expired lease recovery', async () => {
      const queued = await fixture.repository.enqueueJob({
        ownerPluginId: 'corpus',
        type: 'corpus.build',
        payload: {},
        resourceClass: 'python-heavy',
      });
      expect(await fixture.repository.requestJobCancel(queued.id)).toMatchObject({
        state: 'canceled',
      });

      const retry = await fixture.repository.enqueueJob({
        ownerPluginId: 'analytics',
        type: 'analysis.retryable',
        payload: {},
        resourceClass: 'io',
        maxAttempts: 2,
      });
      await fixture.repository.claimJob({
        workerId: 'worker-b',
        resourceClasses: ['io'],
        leaseMs: 1,
      });
      await fixture.repository.startJob(retry.id, 'worker-b', 1);
      expect(
        await fixture.repository.failJob(retry.id, 'worker-b', {
          code: 'WORKER_CRASHED',
          message: 'fixture crash',
          retryable: true,
        }),
      ).toMatchObject({ state: 'queued', phase: 'retrying', attempt: 1 });

      const expiring = await fixture.repository.enqueueJob({
        ownerPluginId: 'collection',
        type: 'crawl.execute',
        payload: {},
        resourceClass: 'browser-heavy',
        maxAttempts: 2,
      });
      await fixture.repository.claimJob({
        workerId: 'worker-c',
        resourceClasses: ['browser-heavy'],
        leaseMs: 1,
      });
      await fixture.repository.startJob(expiring.id, 'worker-c', 1);
      expect(await fixture.repository.recoverExpiredJobs('2999-01-01T00:00:00.000Z')).toBe(1);
      expect(await fixture.repository.getJob(expiring.id)).toMatchObject({
        state: 'queued',
        phase: 'recovered',
        leaseOwner: null,
      });
    });

    it('persists ordered domain events, checkpoints and dead letters', async () => {
      const first = await fixture.repository.appendEvent({
        id: `event-${crypto.randomUUID()}`,
        type: 'analysis.job.created',
        producerPluginId: 'analytics',
        aggregateType: 'analysis-job',
        aggregateId: 'analysis-1',
        payload: { datasetId: 'dataset-1' },
      });
      const second = await fixture.repository.appendEvent({
        id: `event-${crypto.randomUUID()}`,
        type: 'analysis.job.started',
        producerPluginId: 'analytics',
        aggregateType: 'analysis-job',
        aggregateId: 'analysis-1',
        payload: {},
      });
      expect(second.cursor).toBeGreaterThan(first.cursor);
      expect(await fixture.repository.listEvents(first.cursor, 10)).toEqual([second]);
      expect(await fixture.repository.getConsumerCheckpoint('test-consumer')).toBe(0);
      await fixture.repository.saveConsumerCheckpoint('test-consumer', second.cursor);
      await fixture.repository.saveConsumerCheckpoint('test-consumer', first.cursor);
      expect(await fixture.repository.getConsumerCheckpoint('test-consumer')).toBe(second.cursor);
      expect(
        await fixture.repository.recordDeadLetter({
          consumerId: 'test-consumer',
          event: second,
          error: 'fixture error',
        }),
      ).toBe(1);
      expect(
        await fixture.repository.recordDeadLetter({
          consumerId: 'test-consumer',
          event: second,
          error: 'fixture error again',
        }),
      ).toBe(2);
    });

    it('persists artifact metadata without storing artifact contents', async () => {
      const artifact = await fixture.repository.createArtifact({
        ownerPluginId: 'datasets',
        kind: 'dataset-snapshot',
        filename: 'snapshot.parquet',
        contentType: 'application/vnd.apache.parquet',
        size: 42,
        checksum: 'a'.repeat(64),
        storageKey: `snapshots/${crypto.randomUUID()}.parquet`,
        metadata: { fingerprint: 'fixture' },
      });
      expect(await fixture.repository.getArtifact(artifact.id)).toEqual(artifact);
      expect(artifact.metadata).toEqual({ fingerprint: 'fixture' });
    });

    it('reserves, conflicts and replays idempotent mutations', async () => {
      const key = crypto.randomUUID();
      const scope = 'analytics:create-job';
      const requestHash = 'a'.repeat(64);
      const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
      expect(
        await fixture.repository.reserveIdempotency({ scope, key, requestHash, expiresAt }),
      ).toEqual({ state: 'reserved' });
      expect(
        await fixture.repository.reserveIdempotency({ scope, key, requestHash, expiresAt }),
      ).toEqual({ state: 'pending' });
      expect(
        await fixture.repository.reserveIdempotency({
          scope,
          key,
          requestHash: 'b'.repeat(64),
          expiresAt,
        }),
      ).toEqual({ state: 'conflict' });
      await fixture.repository.completeIdempotency({
        scope,
        key,
        requestHash,
        responseStatus: 202,
        responseBody: { jobId: 'analysis-1' },
      });
      expect(
        await fixture.repository.reserveIdempotency({ scope, key, requestHash, expiresAt }),
      ).toEqual({
        state: 'completed',
        responseStatus: 202,
        responseBody: { jobId: 'analysis-1' },
      });
      await expect(
        fixture.repository.completeIdempotency({
          scope,
          key,
          requestHash,
          responseStatus: 202,
          responseBody: { ignored: true },
        }),
      ).resolves.toBeUndefined();
    });
  });
}
