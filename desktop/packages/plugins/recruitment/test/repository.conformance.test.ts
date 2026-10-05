import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformRepository } from '@zhiyun/platform-core';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import type { RecruitmentRepository } from '../src/contracts/index.js';
import type { NormalizedPostingInput } from '../src/domain/index.js';
import { SqliteRecruitmentRepository } from '../src/persistence/sqlite/index.js';

interface Fixture {
  repository: RecruitmentRepository;
  platform: PlatformRepository;
  dispose(): Promise<void>;
}

defineConformance('SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zhiyun-recruitment-sqlite-'));
  const filePath = join(directory, 'zhiyun.sqlite3');
  const platform = await openSqlitePlatformRepository({
    dataDirectory: directory,
    filePath,
    graphRevision: 'recruitment-conformance',
  });
  const repository = new SqliteRecruitmentRepository(filePath);
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

function defineConformance(
  name: string,
  create: () => Promise<Fixture>,
  suite: (name: string, factory: () => void) => unknown = describe,
): void {
  suite(`${name} RecruitmentRepository conformance`, () => {
    let fixture: Fixture;

    beforeAll(async () => {
      fixture = await create();
    });

    afterAll(async () => {
      if (fixture) await fixture.dispose();
    });

    it('records its migration and seeds three authorization-gated sources', async () => {
      expect(await fixture.platform.listMigrations()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ pluginId: 'recruitment', migrationId: '001-initial' }),
        ]),
      );
      expect(await fixture.repository.listSources()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'boss', authorizationStatus: 'pending' }),
          expect.objectContaining({ key: 'liepin', authorizationStatus: 'pending' }),
          expect.objectContaining({ key: 'huibo', authorizationStatus: 'pending' }),
        ]),
      );
    });

    it('enforces profile and mapping revisions', async () => {
      const profile = await fixture.repository.createProfile(profileInput(`profile-${name}`));
      const updated = await fixture.repository.updateProfile(
        profile.id,
        { ...profileInput(`updated-${name}`), priority: 'high' },
        profile.revision,
      );
      expect(updated).toMatchObject({ name: `updated-${name}`, priority: 'high', revision: 2 });
      expect(
        await fixture.repository.updateProfile(profile.id, profileInput('stale'), profile.revision),
      ).toBe('revision-conflict');

      const mapping = await fixture.repository.createMapping({
        sourceKey: 'boss',
        name: `mapping-${name}`,
        headerFingerprint: 'a'.repeat(64),
        fields: { title: '职位', company: '公司', externalId: 'ID' },
      });
      expect(await fixture.repository.findMapping('boss', 'a'.repeat(64))).toEqual(mapping);
      expect(
        await fixture.repository.updateMapping(
          mapping.id,
          { ...mapping, name: `mapping-updated-${name}` },
          mapping.revision,
        ),
      ).toMatchObject({ revision: 2, name: `mapping-updated-${name}` });
    });

    it('upserts source facts, preserves workflow state and supports locked merge/split operations', async () => {
      const profile = await fixture.repository.createProfile(profileInput(`jobs-${name}`));
      const job = await fixture.repository.createImportJob({
        sourceKey: 'boss',
        searchProfileId: profile.id,
        mappingId: null,
        mappingRevision: null,
        filename: 'jobs.csv',
        sha256: 'b'.repeat(64),
        totalRows: 3,
      });
      const first = await fixture.repository.upsertPosting(posting('boss', '1'), {
        importJobId: job.id,
        importRow: 2,
      });
      const unchanged = await fixture.repository.upsertPosting(posting('boss', '1'), {
        importJobId: job.id,
        importRow: 2,
      });
      expect(first.change).toBe('created');
      expect(unchanged.change).toBe('unchanged');

      const second = await fixture.repository.upsertPosting(posting('liepin', '2'), {
        importJobId: job.id,
        importRow: 3,
      });
      const third = await fixture.repository.upsertPosting(posting('huibo', '3'), {
        importJobId: job.id,
        importRow: 4,
      });
      const target = await fixture.repository.createCluster(first.posting);
      await fixture.repository.addPostingToCluster(target.id, second.posting, 1);
      const source = await fixture.repository.createCluster(third.posting);
      await fixture.repository.setWorkflowState(target.id, 'applied', '已投递');
      const merged = await fixture.repository.mergeClusters(target.id, [source.id]);
      expect(merged).toMatchObject({ workflowState: 'applied', note: '已投递' });
      expect(merged?.postings).toHaveLength(3);

      const split = await fixture.repository.splitCluster(target.id, [third.posting.id]);
      expect(split).toMatchObject({ workflowState: 'untracked' });
      expect(split?.postings.map(({ id }) => id)).toEqual([third.posting.id]);
      expect((await fixture.repository.getCluster(target.id))?.postings).toHaveLength(2);

      await fixture.repository.upsertPostingProfile({
        postingId: first.posting.id,
        profileId: profile.id,
        score: 90,
        reasons: ['标题命中'],
      });
      expect(
        (
          await fixture.repository.listClusters({
            profileId: profile.id,
            publishedAfter: '2040-01-01T00:00:00.000Z',
          })
        ).items,
      ).toHaveLength(0);
      const eventInput = {
        profileId: profile.id,
        clusterId: target.id,
        postingId: first.posting.id,
        eventType: 'recruitment.match.detected' as const,
        contentHash: first.posting.contentHash,
        score: 90,
        reasons: ['标题命中'],
      };
      expect(await fixture.repository.createMatchEvent(eventInput)).not.toBeNull();
      expect(await fixture.repository.createMatchEvent(eventInput)).toBeNull();
      expect(await fixture.repository.listUndigestedEvents(profile.id)).toHaveLength(1);

      await fixture.repository.completeAuthorizedSnapshot(
        'boss',
        profile.id,
        [first.posting.id],
        '2030-01-01T00:00:00.000Z',
      );
      await fixture.repository.completeAuthorizedSnapshot(
        'boss',
        profile.id,
        [],
        '2030-01-02T00:00:00.000Z',
      );
      expect(await fixture.repository.getPosting(first.posting.id)).toMatchObject({
        status: 'stale',
      });
      await fixture.repository.completeAuthorizedSnapshot(
        'boss',
        profile.id,
        [],
        '2030-01-05T00:00:00.000Z',
      );
      await fixture.repository.completeAuthorizedSnapshot(
        'boss',
        profile.id,
        [],
        '2030-01-09T00:00:00.000Z',
      );
      expect(await fixture.repository.getPosting(first.posting.id)).toMatchObject({
        status: 'closed',
      });
      const reopened = await fixture.repository.upsertPosting(posting('boss', '1'), {
        importJobId: job.id,
        importRow: 5,
      });
      expect(reopened).toMatchObject({ change: 'reopened', posting: { status: 'reopened' } });
      expect(
        await fixture.repository.upsertPosting(posting('boss', '1'), {
          importJobId: job.id,
          importRow: 6,
        }),
      ).toMatchObject({ change: 'unchanged', posting: { status: 'reopened' } });
    });
  });
}

function profileInput(name: string) {
  return {
    name,
    includeKeywords: ['TypeScript'],
    keywordMode: 'any' as const,
    excludeKeywords: [],
    cities: ['上海'],
    remoteAllowed: true,
    salaryMinMonthly: null,
    salaryMaxMonthly: null,
    experience: [],
    education: [],
    employmentTypes: [],
    includeCompanies: [],
    excludeCompanies: [],
    sourceKeys: ['boss', 'liepin', 'huibo'] as Array<'boss' | 'liepin' | 'huibo'>,
    freshnessDays: 30,
    priority: 'normal' as const,
    enabled: true,
    digestTime: '08:00',
    timezone: 'Asia/Shanghai',
    outputDestinationIds: [],
  };
}

function posting(sourceKey: 'boss' | 'liepin' | 'huibo', id: string): NormalizedPostingInput {
  return {
    sourceKey,
    stableKey: `id:${id}`,
    externalId: id,
    sourceUrl:
      sourceKey === 'boss'
        ? `https://www.zhipin.com/job/${id}`
        : sourceKey === 'liepin'
          ? `https://www.liepin.com/job/${id}`
          : `https://www.huibo.com/job/${id}`,
    title: 'TypeScript 工程师',
    company: '织云科技有限公司',
    location: '上海',
    salaryRaw: '20-30K',
    salaryMinMonthly: 20_000,
    salaryMaxMonthly: 30_000,
    salaryMonths: 12,
    description: 'TypeScript 数据平台',
    publishedAt: new Date().toISOString(),
    expiresAt: null,
    experience: null,
    education: null,
    employmentType: null,
    skills: ['TypeScript'],
    status: 'active',
    normalizedTitle: 'typescript工程师',
    normalizedCompany: '织云科技',
    normalizedLocation: '上海',
    contentHash: id.padEnd(64, id).slice(0, 64),
    normalizerVersion: '1.0.0',
  };
}
