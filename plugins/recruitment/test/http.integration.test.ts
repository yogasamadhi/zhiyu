import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import { RecruitmentService } from '../src/application/index.js';
import type {
  RecruitmentSourceAdapter,
  ReviewedRecruitmentAdapter,
} from '../src/contracts/index.js';
import { normalizeRecruitmentRow } from '../src/domain/index.js';
import { registerRecruitmentHttp } from '../src/http/index.js';
import { SqliteRecruitmentRepository } from '../src/persistence/sqlite/index.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe('recruitment HTTP integration', () => {
  it('keeps all live source syncs authorization-gated without network access', async () => {
    const fixture = await createFixture();
    const network = vi.spyOn(globalThis, 'fetch');
    try {
      const sources = await fixture.app.inject({
        method: 'GET',
        url: '/api/v2/recruitment/sources',
      });
      expect(sources.statusCode).toBe(200);
      expect(sources.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'boss',
            authorizationStatus: 'pending',
            liveSyncAvailable: false,
          }),
          expect.objectContaining({
            key: 'liepin',
            authorizationStatus: 'pending',
            liveSyncAvailable: false,
          }),
          expect.objectContaining({
            key: 'huibo',
            authorizationStatus: 'pending',
            liveSyncAvailable: false,
          }),
        ]),
      );
      for (const sourceKey of ['boss', 'liepin', 'huibo']) {
        const response = await fixture.app.inject({
          method: 'POST',
          url: `/api/v2/recruitment/sources/${sourceKey}/sync`,
        });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ code: 'SOURCE_AUTHORIZATION_REQUIRED' });
      }
      expect(network).not.toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
  });

  it('creates a profile, previews/imports CSV idempotently and persists workflow state', async () => {
    const fixture = await createFixture();
    try {
      const profileResponse = await fixture.app.inject({
        method: 'POST',
        url: '/api/v2/recruitment/search-profiles',
        payload: profileInput(),
      });
      expect(profileResponse.statusCode).toBe(201);
      const profile = profileResponse.json() as { id: string };
      const content = [
        '职位ID,职位名称,公司名称,职位链接,城市,薪资,职位描述',
        'boss-1,TypeScript工程师,织云科技有限公司,https://www.zhipin.com/job/1,上海,20-30K,数据平台建设',
        'bad,,缺少标题,https://www.zhipin.com/job/2,上海,面议,无',
      ].join('\n');
      const file = {
        sourceKey: 'boss',
        searchProfileId: profile.id,
        filename: 'boss.csv',
        format: 'csv',
        content,
        saveMapping: true,
        mappingName: 'BOSS 导出',
      };
      const preview = await fixture.app.inject({
        method: 'POST',
        url: '/api/v2/recruitment/imports/preview',
        payload: file,
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({
        totalRows: 2,
        suggestedMapping: { externalId: '职位ID', title: '职位名称', company: '公司名称' },
      });
      const imported = await fixture.app.inject({
        method: 'POST',
        url: '/api/v2/recruitment/imports',
        payload: { ...file, mapping: preview.json().suggestedMapping },
      });
      expect(imported.statusCode).toBe(201);
      expect(imported.json()).toMatchObject({
        status: 'succeeded',
        importedRows: 1,
        createdRows: 1,
        errorRows: 1,
      });
      const repeated = await fixture.app.inject({
        method: 'POST',
        url: '/api/v2/recruitment/imports',
        payload: { ...file, saveMapping: false, mapping: preview.json().suggestedMapping },
      });
      expect(repeated.json()).toMatchObject({ createdRows: 0, unchangedRows: 1, errorRows: 1 });
      expect(fixture.notifications).toHaveLength(1);
      expect(
        (await fixture.platform.listEvents(0, 100)).filter(
          (event) => event.type === 'recruitment.match.detected',
        ),
      ).toHaveLength(1);

      expect(await fixture.service.runDueDigests(new Date('2030-01-01T01:00:00.000Z'))).toBe(1);
      expect(await fixture.service.runDueDigests(new Date('2030-01-01T02:00:00.000Z'))).toBe(0);
      expect(fixture.notifications).toHaveLength(2);
      expect(
        (await fixture.platform.listEvents(0, 100)).filter(
          (event) => event.type === 'recruitment.digest.ready',
        ),
      ).toHaveLength(1);

      const clusters = await fixture.app.inject({
        method: 'GET',
        url: `/api/v2/recruitment/job-clusters?profileId=${profile.id}`,
      });
      expect(clusters.statusCode).toBe(200);
      expect(clusters.json().items).toHaveLength(1);
      expect(clusters.json().items[0]).toMatchObject({
        title: 'TypeScript工程师',
        company: '织云科技有限公司',
        matchScore: 80,
        workflowState: 'untracked',
      });
      const clusterId = clusters.json().items[0].id as string;
      const state = await fixture.app.inject({
        method: 'PUT',
        url: `/api/v2/recruitment/job-clusters/${clusterId}/state`,
        payload: { state: 'applied', note: '2026-09-01 已投递' },
      });
      expect(state.statusCode).toBe(200);
      expect(state.json()).toMatchObject({ workflowState: 'applied', note: '2026-09-01 已投递' });
    } finally {
      await fixture.dispose();
    }
  });

  it('runs only an explicitly reviewed, credential-backed fixture adapter', async () => {
    const fixture = await createFixture({ authorizedFixture: true });
    const network = vi.spyOn(globalThis, 'fetch');
    try {
      const profile = await fixture.app.inject({
        method: 'POST',
        url: '/api/v2/recruitment/search-profiles',
        payload: profileInput(),
      });
      expect(profile.statusCode).toBe(201);

      const first = await fixture.app.inject({
        method: 'POST',
        url: '/api/v2/recruitment/sources/boss/sync',
      });
      expect(first.statusCode).toBe(202);
      expect(first.json()).toMatchObject({
        sourceKey: 'boss',
        profiles: 1,
        pages: 2,
        importedRows: 2,
        createdRows: 2,
        errorRows: 0,
        complete: true,
      });

      const repeated = await fixture.app.inject({
        method: 'POST',
        url: '/api/v2/recruitment/sources/boss/sync',
      });
      expect(repeated.statusCode).toBe(202);
      expect(repeated.json()).toMatchObject({ importedRows: 2, unchangedRows: 2 });
      expect(network).not.toHaveBeenCalled();
    } finally {
      await fixture.dispose();
    }
  });
});

async function createFixture(options: { authorizedFixture?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'zhiyun-recruitment-http-'));
  directories.push(directory);
  const filePath = join(directory, 'zhiyun.sqlite3');
  const platform = await openSqlitePlatformRepository({
    dataDirectory: directory,
    filePath,
    graphRevision: 'recruitment-http-test',
  });
  const repository = new SqliteRecruitmentRepository(filePath);
  await repository.migrate();
  const reviewed: ReviewedRecruitmentAdapter = {
    sourceKey: 'boss',
    version: 'fixture-1.0.0',
    authorizationScope: 'jobs.read.fixture',
    credentialRef: 'credential:fixture-boss',
  };
  if (options.authorizedFixture) await repository.installAuthorizedSource(reviewed);
  const adapter = fixtureAdapter(reviewed);
  const notifications: string[] = [];
  const service = new RecruitmentService({
    repository,
    platform,
    replaceOutputBindings: async () => undefined,
    clearOutputBindings: async () => undefined,
    notify: async (title, body) => {
      notifications.push(`${title}:${body}`);
    },
    ...(options.authorizedFixture
      ? {
          adapters: [adapter],
          reviewedAdapters: [reviewed],
          resolveCredential: async (reference: string) => {
            if (reference !== reviewed.credentialRef) throw new Error('missing fixture credential');
            return { token: 'fixture-only' };
          },
        }
      : {}),
  });
  const app = Fastify();
  await registerRecruitmentHttp(app, service);
  return {
    app,
    service,
    platform,
    notifications,
    async dispose() {
      await app.close();
      await repository.close();
      await platform.close();
    },
  };
}

function fixtureAdapter(manifest: ReviewedRecruitmentAdapter): RecruitmentSourceAdapter {
  const rows = [
    {
      id: 'fixture-1',
      url: 'https://www.zhipin.com/job/fixture-1',
      title: 'TypeScript 工程师',
      company: '织云科技有限公司',
      city: '上海',
      salary: '20-30K',
      description: 'TypeScript 数据平台',
    },
    {
      id: 'fixture-2',
      url: 'https://www.zhipin.com/job/fixture-2',
      title: '高级 TypeScript 工程师',
      company: '示例科技有限公司',
      city: '上海',
      salary: '30-40K',
      description: 'TypeScript 工程化',
    },
  ];
  return {
    sourceKey: manifest.sourceKey,
    version: manifest.version,
    authorizationScope: manifest.authorizationScope,
    credentialRef: manifest.credentialRef,
    async health({ credential }) {
      return { ok: Boolean(credential) };
    },
    async collect({ cursor }) {
      return cursor
        ? { rows: [rows[1]!], nextCursor: null, complete: true }
        : { rows: [rows[0]!], nextCursor: 'page-2', complete: false };
    },
    normalize(row) {
      return normalizeRecruitmentRow('boss', row, {
        externalId: 'id',
        sourceUrl: 'url',
        title: 'title',
        company: 'company',
        location: 'city',
        salaryRaw: 'salary',
        description: 'description',
      });
    },
  };
}

function profileInput() {
  return {
    name: '上海 TypeScript',
    includeKeywords: ['TypeScript'],
    keywordMode: 'any',
    excludeKeywords: [],
    cities: ['上海'],
    remoteAllowed: true,
    salaryMinMonthly: 20_000,
    salaryMaxMonthly: 40_000,
    experience: [],
    education: [],
    employmentTypes: [],
    includeCompanies: [],
    excludeCompanies: [],
    sourceKeys: ['boss'],
    freshnessDays: 30,
    priority: 'high',
    enabled: true,
    digestTime: '08:00',
    timezone: 'Asia/Shanghai',
    outputDestinationIds: [],
  };
}
