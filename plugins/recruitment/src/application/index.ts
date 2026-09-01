import { createHash, randomUUID } from 'node:crypto';
import {
  recruitmentFileInputSchema,
  recruitmentImportMappingInputSchema,
  recruitmentSearchProfileInputSchema,
  recruitmentWorkflowUpdateSchema,
  type RecruitmentFileInput,
  type RecruitmentImportJob,
  type RecruitmentImportMapping,
  type RecruitmentImportMappingInput,
  type RecruitmentImportPreview,
  type RecruitmentJobCluster,
  type RecruitmentSearchProfile,
  type RecruitmentSearchProfileInput,
  type RecruitmentSource,
  type RecruitmentSourceKey,
  type RecruitmentSyncResult,
  type RecruitmentWorkflowUpdate,
} from '@zhiyun/shared';
import type { PlatformRepository } from '@zhiyun/platform-core';
import type {
  RecruitmentClusterPage,
  RecruitmentClusterQuery,
  PostingUpsertResult,
  RecruitmentRepository,
  RecruitmentSourceAdapter,
  ReviewedRecruitmentAdapter,
} from '../contracts/index.js';
import {
  RECRUITMENT_IMPORT_BATCH_SIZE,
  RECRUITMENT_MAX_ROWS,
  RECRUITMENT_SOURCE_CATALOG,
  buildRecruitmentSearchUrl,
  guessRecruitmentMapping,
  headerFingerprint,
  matchRecruitmentProfile,
  normalizeRecruitmentRow,
  parseRecruitmentFile,
  recruitmentClusterSimilarity,
} from '../domain/index.js';

const importFields = new Set([
  'externalId',
  'sourceUrl',
  'title',
  'company',
  'location',
  'salaryRaw',
  'description',
  'publishedAt',
  'expiresAt',
  'experience',
  'education',
  'employmentType',
  'skills',
  'status',
]);

export interface RecruitmentServiceDependencies {
  repository: RecruitmentRepository;
  platform: Pick<PlatformRepository, 'appendEvent'>;
  replaceOutputBindings(profileId: string, destinationIds: readonly string[]): Promise<void>;
  clearOutputBindings(profileId: string): Promise<void>;
  notify?(title: string, body: string): Promise<void>;
  createErrorArtifact?(
    importJobId: string,
    filename: string,
    content: string,
  ): Promise<string | null>;
  adapters?: readonly RecruitmentSourceAdapter[];
  reviewedAdapters?: readonly ReviewedRecruitmentAdapter[];
  resolveCredential?(reference: string): Promise<unknown>;
}

export class RecruitmentService {
  private readonly adapters: ReadonlyMap<RecruitmentSourceKey, RecruitmentSourceAdapter>;
  private readonly reviewedAdapters: ReadonlyMap<RecruitmentSourceKey, ReviewedRecruitmentAdapter>;

  constructor(private readonly dependencies: RecruitmentServiceDependencies) {
    this.adapters = new Map(
      (dependencies.adapters ?? []).map((adapter) => [adapter.sourceKey, adapter]),
    );
    this.reviewedAdapters = new Map(
      (dependencies.reviewedAdapters ?? []).map((adapter) => [adapter.sourceKey, adapter]),
    );
  }

  async listSources(profileId?: string): Promise<Array<RecruitmentSource & { searchUrl: string }>> {
    const profile = profileId ? await this.dependencies.repository.getProfile(profileId) : null;
    return (await this.dependencies.repository.listSources()).map((source) => ({
      ...source,
      searchUrl: buildRecruitmentSearchUrl(source.key, profile ?? undefined),
    }));
  }

  async getSource(
    sourceKey: RecruitmentSourceKey,
    profileId?: string,
  ): Promise<(RecruitmentSource & { searchUrl: string }) | null> {
    const source = await this.dependencies.repository.getSource(sourceKey);
    if (!source) return null;
    const profile = profileId ? await this.dependencies.repository.getProfile(profileId) : null;
    return { ...source, searchUrl: buildRecruitmentSearchUrl(sourceKey, profile ?? undefined) };
  }

  async syncSource(sourceKey: RecruitmentSourceKey): Promise<RecruitmentSyncResult> {
    const source = await this.dependencies.repository.getSource(sourceKey);
    if (!source) throw new RecruitmentServiceError(404, 'NOT_FOUND', '招聘来源不存在');
    const adapter = this.adapters.get(sourceKey);
    const reviewed = this.reviewedAdapters.get(sourceKey);
    if (
      source.authorizationStatus !== 'authorized' ||
      source.mode !== 'authorized_sync' ||
      !source.liveSyncAvailable ||
      !source.adapterVersion ||
      !source.authorizationScope ||
      !source.credentialRef ||
      !adapter ||
      !reviewed ||
      !this.dependencies.resolveCredential ||
      adapter.version !== source.adapterVersion ||
      adapter.authorizationScope !== source.authorizationScope ||
      adapter.credentialRef !== source.credentialRef ||
      reviewed.version !== source.adapterVersion ||
      reviewed.authorizationScope !== source.authorizationScope ||
      reviewed.credentialRef !== source.credentialRef
    ) {
      throw new RecruitmentServiceError(
        409,
        'SOURCE_AUTHORIZATION_REQUIRED',
        `${source.name} 尚未安装经过审查的授权适配器；当前只允许文件导入和原站跳转`,
      );
    }
    const startedAt = new Date();
    try {
      const credential = await this.dependencies.resolveCredential(source.credentialRef);
      const health = await adapter.health({ credential });
      if (!health.ok) throw new Error(health.detail || '授权适配器健康检查失败');
      const profiles = (await this.dependencies.repository.listProfiles()).filter(
        (profile) => profile.enabled && profile.sourceKeys.includes(sourceKey),
      );
      const totals = {
        pages: 0,
        importedRows: 0,
        createdRows: 0,
        updatedRows: 0,
        unchangedRows: 0,
        errorRows: 0,
      };
      let complete = true;
      for (const profile of profiles) {
        const job = await this.dependencies.repository.createImportJob({
          sourceKey,
          searchProfileId: profile.id,
          mappingId: null,
          mappingRevision: null,
          filename: `authorized-sync-${sourceKey}-${adapter.version}.json`,
          sha256: createHash('sha256')
            .update(`${sourceKey}:${adapter.version}:${profile.id}:${startedAt.toISOString()}`)
            .digest('hex'),
          totalRows: 0,
        });
        const counters = { imported: 0, created: 0, updated: 0, unchanged: 0 };
        const errors: Array<{ row: number; message: string; data?: unknown }> = [];
        let cursor: string | undefined;
        const cursors = new Set<string>();
        let finalPageComplete = false;
        let fatal: unknown;
        let rowNumber = 0;
        const seenPostingIds: string[] = [];
        try {
          do {
            const page = await adapter.collect({
              profile,
              credential,
              ...(cursor ? { cursor } : {}),
            });
            totals.pages += 1;
            if (counters.imported + errors.length + page.rows.length > RECRUITMENT_MAX_ROWS) {
              throw new Error('授权同步单个搜索档案不能超过 100,000 行');
            }
            for (const row of page.rows) {
              rowNumber += 1;
              try {
                const normalized = adapter.normalize(row);
                if (normalized.sourceKey !== sourceKey) {
                  throw new Error('授权适配器返回了错误的来源标识');
                }
                const upserted = await this.processPosting(profile, normalized, {
                  importJobId: job.id,
                  importRow: rowNumber,
                });
                seenPostingIds.push(upserted.posting.id);
                counters.imported += 1;
                if (upserted.change === 'created') counters.created += 1;
                else if (upserted.change === 'unchanged') counters.unchanged += 1;
                else counters.updated += 1;
              } catch (error) {
                errors.push({
                  row: rowNumber,
                  message: error instanceof Error ? error.message : String(error),
                  data: redactErrorRow(row),
                });
              }
            }
            finalPageComplete = page.complete && page.nextCursor === null;
            if (page.nextCursor) {
              if (cursors.has(page.nextCursor)) throw new Error('授权适配器返回了循环分页游标');
              cursors.add(page.nextCursor);
              cursor = page.nextCursor;
            } else cursor = undefined;
          } while (cursor);
        } catch (error) {
          fatal = error;
          errors.push({ row: 0, message: error instanceof Error ? error.message : String(error) });
        }
        await this.dependencies.repository.saveImportErrors(job.id, errors);
        const errorArtifactId = await this.createImportErrorArtifact(job.id, job.filename, errors);
        await this.dependencies.repository.finishImportJob(job.id, {
          status: fatal || (counters.imported === 0 && errors.length > 0) ? 'failed' : 'succeeded',
          importedRows: counters.imported,
          createdRows: counters.created,
          updatedRows: counters.updated,
          unchangedRows: counters.unchanged,
          errorRows: errors.length,
          errorArtifactId,
          errorSummary: errors.slice(0, 100).map(({ row, message }) => ({ row, message })),
        });
        if (finalPageComplete && !fatal && errors.length === 0) {
          await this.dependencies.repository.completeAuthorizedSnapshot(
            sourceKey,
            profile.id,
            seenPostingIds,
            new Date().toISOString(),
          );
        }
        totals.importedRows += counters.imported;
        totals.createdRows += counters.created;
        totals.updatedRows += counters.updated;
        totals.unchangedRows += counters.unchanged;
        totals.errorRows += errors.length;
        complete &&= finalPageComplete && !fatal;
        if (fatal) throw fatal;
      }
      const completedAt = new Date().toISOString();
      await this.dependencies.repository.markSourceSynced(sourceKey, completedAt, null);
      return {
        sourceKey,
        profiles: profiles.length,
        ...totals,
        complete,
        completedAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.dependencies.repository.markSourceSynced(
        sourceKey,
        new Date().toISOString(),
        message,
      );
      throw error instanceof RecruitmentServiceError
        ? error
        : new RecruitmentServiceError(503, 'SOURCE_SYNC_FAILED', message);
    }
  }

  listProfiles(): Promise<RecruitmentSearchProfile[]> {
    return this.dependencies.repository.listProfiles();
  }

  async getProfile(id: string): Promise<RecruitmentSearchProfile> {
    const profile = await this.dependencies.repository.getProfile(id);
    if (!profile) throw new RecruitmentServiceError(404, 'NOT_FOUND', '搜索档案不存在');
    return profile;
  }

  async createProfile(input: RecruitmentSearchProfileInput): Promise<RecruitmentSearchProfile> {
    const parsed = recruitmentSearchProfileInputSchema.parse(input);
    const profile = await this.dependencies.repository.createProfile(parsed);
    await this.dependencies.replaceOutputBindings(profile.id, parsed.outputDestinationIds);
    return profile;
  }

  async updateProfile(
    id: string,
    input: RecruitmentSearchProfileInput,
    expectedRevision: number,
  ): Promise<RecruitmentSearchProfile> {
    const parsed = recruitmentSearchProfileInputSchema.parse(input);
    const updated = await this.dependencies.repository.updateProfile(id, parsed, expectedRevision);
    if (!updated) throw new RecruitmentServiceError(404, 'NOT_FOUND', '搜索档案不存在');
    if (updated === 'revision-conflict') {
      throw new RecruitmentServiceError(409, 'REVISION_CONFLICT', '搜索档案已被其他操作更新');
    }
    await this.dependencies.replaceOutputBindings(updated.id, parsed.outputDestinationIds);
    return updated;
  }

  async deleteProfile(id: string): Promise<boolean> {
    const deleted = await this.dependencies.repository.deleteProfile(id);
    if (deleted) await this.dependencies.clearOutputBindings(id);
    return deleted;
  }

  listMappings(sourceKey?: RecruitmentSourceKey): Promise<RecruitmentImportMapping[]> {
    return this.dependencies.repository.listMappings(sourceKey);
  }

  async createMapping(input: RecruitmentImportMappingInput): Promise<RecruitmentImportMapping> {
    const parsed = recruitmentImportMappingInputSchema.parse(input);
    validateMapping(parsed.fields);
    return this.dependencies.repository.createMapping(parsed);
  }

  async updateMapping(
    id: string,
    input: RecruitmentImportMappingInput,
    expectedRevision: number,
  ): Promise<RecruitmentImportMapping> {
    const parsed = recruitmentImportMappingInputSchema.parse(input);
    validateMapping(parsed.fields);
    const updated = await this.dependencies.repository.updateMapping(id, parsed, expectedRevision);
    if (!updated) throw new RecruitmentServiceError(404, 'NOT_FOUND', '字段映射不存在');
    if (updated === 'revision-conflict') {
      throw new RecruitmentServiceError(409, 'REVISION_CONFLICT', '字段映射已被其他操作更新');
    }
    return updated;
  }

  deleteMapping(id: string): Promise<boolean> {
    return this.dependencies.repository.deleteMapping(id);
  }

  async previewFile(input: RecruitmentFileInput): Promise<RecruitmentImportPreview> {
    const parsedInput = recruitmentFileInputSchema.parse(input);
    await this.requireImportScope(parsedInput.sourceKey, parsedInput.searchProfileId);
    const parsed = parseRecruitmentFile(parsedInput.format, parsedInput.content);
    const fingerprint = headerFingerprint(parsed.headers);
    const reusableMapping = await this.dependencies.repository.findMapping(
      parsedInput.sourceKey,
      fingerprint,
    );
    return {
      format: parsedInput.format,
      filename: parsedInput.filename,
      size: Buffer.byteLength(parsedInput.content),
      totalRows: parsed.rows.length,
      headers: parsed.headers,
      headerFingerprint: fingerprint,
      sample: parsed.rows.slice(0, 20),
      suggestedMapping: reusableMapping?.fields ?? guessRecruitmentMapping(parsed.headers),
      reusableMapping,
    };
  }

  async importFile(input: RecruitmentFileInput): Promise<RecruitmentImportJob> {
    const parsedInput = recruitmentFileInputSchema.parse(input);
    const profile = await this.requireImportScope(
      parsedInput.sourceKey,
      parsedInput.searchProfileId,
    );
    const parsed = parseRecruitmentFile(parsedInput.format, parsedInput.content);
    const fingerprint = headerFingerprint(parsed.headers);
    let mapping: RecruitmentImportMapping | null = null;
    if (parsedInput.mappingId) {
      mapping = await this.dependencies.repository.getMapping(parsedInput.mappingId);
      if (!mapping || mapping.sourceKey !== parsedInput.sourceKey) {
        throw new RecruitmentServiceError(422, 'VALIDATION_ERROR', '字段映射与招聘来源不匹配');
      }
      if (mapping.headerFingerprint !== fingerprint) {
        throw new RecruitmentServiceError(422, 'VALIDATION_ERROR', '字段映射不适用于当前文件表头');
      }
    }
    const fields =
      parsedInput.mapping ?? mapping?.fields ?? guessRecruitmentMapping(parsed.headers);
    validateMapping(fields, parsed.headers);
    if (parsedInput.saveMapping && !mapping) {
      mapping = await this.dependencies.repository.createMapping({
        sourceKey: parsedInput.sourceKey,
        name: parsedInput.mappingName ?? `${parsedInput.sourceKey}-${parsedInput.filename}`,
        headerFingerprint: fingerprint,
        fields,
      });
    }
    const job = await this.dependencies.repository.createImportJob({
      sourceKey: parsedInput.sourceKey,
      searchProfileId: parsedInput.searchProfileId,
      mappingId: mapping?.id ?? null,
      mappingRevision: mapping?.revision ?? null,
      filename: parsedInput.filename,
      sha256: createHash('sha256').update(parsedInput.content).digest('hex'),
      totalRows: parsed.rows.length,
    });
    const counters = { imported: 0, created: 0, updated: 0, unchanged: 0 };
    const errors: Array<{ row: number; message: string; data?: unknown }> = [];
    for (let offset = 0; offset < parsed.rows.length; offset += RECRUITMENT_IMPORT_BATCH_SIZE) {
      const batch = parsed.rows.slice(offset, offset + RECRUITMENT_IMPORT_BATCH_SIZE);
      for (const [batchIndex, row] of batch.entries()) {
        const rowNumber = offset + batchIndex + 2;
        try {
          const normalized = normalizeRecruitmentRow(parsedInput.sourceKey, row, fields);
          const upserted = await this.processPosting(profile, normalized, {
            importJobId: job.id,
            importRow: rowNumber,
          });
          counters.imported += 1;
          if (upserted.change === 'created') counters.created += 1;
          else if (upserted.change === 'unchanged') counters.unchanged += 1;
          else counters.updated += 1;
        } catch (error) {
          errors.push({
            row: rowNumber,
            message: error instanceof Error ? error.message : String(error),
            data: redactErrorRow(row),
          });
        }
      }
    }
    await this.dependencies.repository.saveImportErrors(job.id, errors);
    const errorArtifactId = await this.createImportErrorArtifact(
      job.id,
      parsedInput.filename,
      errors,
    );
    const completed = await this.dependencies.repository.finishImportJob(job.id, {
      status: counters.imported === 0 && errors.length > 0 ? 'failed' : 'succeeded',
      importedRows: counters.imported,
      createdRows: counters.created,
      updatedRows: counters.updated,
      unchangedRows: counters.unchanged,
      errorRows: errors.length,
      errorArtifactId,
      errorSummary: errors.slice(0, 100).map(({ row, message }) => ({ row, message })),
    });
    await this.dependencies.repository.markSourceImported(
      parsedInput.sourceKey,
      completed.completedAt ?? new Date().toISOString(),
    );
    return completed;
  }

  getImportJob(id: string): Promise<RecruitmentImportJob | null> {
    return this.dependencies.repository.getImportJob(id);
  }

  getImportErrors(id: string): Promise<Array<{ row: number; message: string; data?: unknown }>> {
    return this.dependencies.repository.getImportErrors(id);
  }

  listClusters(query: RecruitmentClusterQuery): Promise<RecruitmentClusterPage> {
    return this.dependencies.repository.listClusters(query);
  }

  async getCluster(id: string, profileId?: string): Promise<RecruitmentJobCluster> {
    const cluster = await this.dependencies.repository.getCluster(id, profileId);
    if (!cluster) throw new RecruitmentServiceError(404, 'NOT_FOUND', '职位簇不存在');
    return cluster;
  }

  async setWorkflowState(
    id: string,
    input: RecruitmentWorkflowUpdate,
  ): Promise<RecruitmentJobCluster> {
    const parsed = recruitmentWorkflowUpdateSchema.parse(input);
    const cluster = await this.dependencies.repository.setWorkflowState(
      id,
      parsed.state,
      parsed.note,
    );
    if (!cluster) throw new RecruitmentServiceError(404, 'NOT_FOUND', '职位簇不存在');
    return cluster;
  }

  async mergeClusters(
    targetClusterId: string,
    sourceClusterIds: readonly string[],
  ): Promise<RecruitmentJobCluster> {
    const cluster = await this.dependencies.repository.mergeClusters(
      targetClusterId,
      sourceClusterIds,
    );
    if (!cluster) throw new RecruitmentServiceError(404, 'NOT_FOUND', '目标职位簇不存在');
    return cluster;
  }

  async splitCluster(
    clusterId: string,
    postingIds: readonly string[],
  ): Promise<RecruitmentJobCluster> {
    const cluster = await this.dependencies.repository.splitCluster(clusterId, postingIds);
    if (!cluster) {
      throw new RecruitmentServiceError(
        422,
        'VALIDATION_ERROR',
        '拆分必须选择职位簇中的部分来源职位',
      );
    }
    return cluster;
  }

  async runDueDigests(now = new Date()): Promise<number> {
    let generated = 0;
    for (const profile of await this.dependencies.repository.listProfiles()) {
      if (!profile.enabled || !digestDue(profile, now)) continue;
      const events = await this.dependencies.repository.listUndigestedEvents(profile.id);
      const timestamp = now.toISOString();
      if (events.length > 0) {
        const detectedEvents = events.filter(
          (event) => event.eventType === 'recruitment.match.detected',
        );
        const detectedPostings = await Promise.all(
          detectedEvents.map((event) => this.dependencies.repository.getPosting(event.postingId)),
        );
        const reopened = detectedPostings.filter(
          (posting) => posting?.status === 'reopened',
        ).length;
        const detected = detectedEvents.length - reopened;
        const changed = events.length - detectedEvents.length;
        const eventId = randomUUID();
        await this.dependencies.platform.appendEvent({
          id: eventId,
          type: 'recruitment.digest.ready',
          producerPluginId: 'recruitment',
          aggregateType: 'recruitment-profile',
          aggregateId: profile.id,
          occurredAt: timestamp,
          payload: {
            taskId: profile.id,
            runId: null,
            profileId: profile.id,
            profileName: profile.name,
            detected,
            changed,
            reopened,
            clusterIds: [...new Set(events.map((event) => event.clusterId))].slice(0, 100),
          },
        });
        await this.dependencies.notify?.(
          `职位雷达 · ${profile.name}`,
          `今日新增 ${detected} 个匹配，${changed} 个职位有变化，${reopened} 个重新开放`,
        );
        generated += 1;
      }
      await this.dependencies.repository.markEventsDigested(profile.id, timestamp);
      await this.dependencies.repository.markProfileDigested(profile.id, timestamp);
    }
    return generated;
  }

  private async processPosting(
    profile: RecruitmentSearchProfile,
    normalized: Parameters<RecruitmentRepository['upsertPosting']>[0],
    provenance: Parameters<RecruitmentRepository['upsertPosting']>[1],
  ): Promise<PostingUpsertResult> {
    const upserted = await this.dependencies.repository.upsertPosting(normalized, provenance);
    const cluster = await this.assignCluster(upserted.posting);
    const matched = matchRecruitmentProfile(profile, upserted.posting);
    if (!matched.matched) {
      await this.dependencies.repository.deletePostingProfile(upserted.posting.id, profile.id);
      return upserted;
    }
    await this.dependencies.repository.upsertPostingProfile({
      postingId: upserted.posting.id,
      profileId: profile.id,
      score: matched.score,
      reasons: matched.reasons,
    });
    const eventType =
      upserted.change === 'created' || upserted.change === 'reopened'
        ? 'recruitment.match.detected'
        : upserted.change === 'updated'
          ? 'recruitment.posting.changed'
          : null;
    if (eventType) {
      await this.publishMatchEvent(
        profile,
        cluster,
        upserted.posting,
        eventType,
        matched.score,
        matched.reasons,
      );
    }
    return upserted;
  }

  private async createImportErrorArtifact(
    importJobId: string,
    filename: string,
    errors: Array<{ row: number; message: string; data?: unknown }>,
  ): Promise<string | null> {
    if (errors.length === 0 || !this.dependencies.createErrorArtifact) return null;
    const content = `${errors.map((error) => JSON.stringify(error)).join('\n')}\n`;
    return this.dependencies.createErrorArtifact(
      importJobId,
      `${safeFilename(filename)}.errors.jsonl`,
      content,
    );
  }

  private async requireImportScope(
    sourceKey: RecruitmentSourceKey,
    profileId: string,
  ): Promise<RecruitmentSearchProfile> {
    if (!RECRUITMENT_SOURCE_CATALOG.some((source) => source.key === sourceKey)) {
      throw new RecruitmentServiceError(404, 'NOT_FOUND', '招聘来源不存在');
    }
    const profile = await this.dependencies.repository.getProfile(profileId);
    if (!profile) throw new RecruitmentServiceError(404, 'NOT_FOUND', '搜索档案不存在');
    if (!profile.sourceKeys.includes(sourceKey)) {
      throw new RecruitmentServiceError(422, 'VALIDATION_ERROR', '搜索档案未启用该来源');
    }
    return profile;
  }

  private async assignCluster(
    posting: Parameters<RecruitmentRepository['listCandidateClusters']>[0],
  ): Promise<RecruitmentJobCluster> {
    const candidates = await this.dependencies.repository.listCandidateClusters(posting);
    const scored = candidates
      .map((cluster) => {
        const representative =
          cluster.postings.find((candidate) => candidate.id === cluster.representativePostingId) ??
          cluster.postings[0];
        return representative
          ? { cluster, ...recruitmentClusterSimilarity(posting, representative) }
          : { cluster, score: 0, evidence: {} };
      })
      .sort((left, right) => right.score - left.score);
    const automatic = scored.find((candidate) => candidate.score >= 0.92);
    if (automatic) {
      await this.dependencies.repository.addPostingToCluster(
        automatic.cluster.id,
        posting,
        automatic.score,
      );
      return (await this.dependencies.repository.getCluster(automatic.cluster.id))!;
    }
    const cluster = await this.dependencies.repository.createCluster(posting);
    for (const candidate of scored.filter((item) => item.score >= 0.75 && item.score < 0.92)) {
      await this.dependencies.repository.addClusterSuggestion({
        clusterId: cluster.id,
        candidateClusterId: candidate.cluster.id,
        score: candidate.score,
        evidence: candidate.evidence,
      });
    }
    return (await this.dependencies.repository.getCluster(cluster.id))!;
  }

  private async publishMatchEvent(
    profile: RecruitmentSearchProfile,
    cluster: RecruitmentJobCluster,
    posting: RecruitmentJobCluster['postings'][number],
    eventType: 'recruitment.match.detected' | 'recruitment.posting.changed',
    score: number,
    reasons: string[],
  ): Promise<void> {
    const matchEvent = await this.dependencies.repository.createMatchEvent({
      profileId: profile.id,
      clusterId: cluster.id,
      postingId: posting.id,
      eventType,
      contentHash: posting.contentHash,
      score,
      reasons,
    });
    if (!matchEvent) return;
    await this.dependencies.platform.appendEvent({
      id: matchEvent.id,
      type: eventType,
      producerPluginId: 'recruitment',
      aggregateType: 'recruitment-cluster',
      aggregateId: cluster.id,
      occurredAt: matchEvent.createdAt,
      payload: {
        taskId: profile.id,
        runId: null,
        profileId: profile.id,
        profileName: profile.name,
        clusterId: cluster.id,
        postingId: posting.id,
        sourceKey: posting.sourceKey,
        title: posting.title,
        company: posting.company,
        score,
        reasons,
      },
    });
    if (profile.priority === 'high' && eventType === 'recruitment.match.detected') {
      await this.dependencies.notify?.(
        posting.status === 'reopened' ? '高优先级职位重新开放' : '发现高优先级职位',
        `${posting.company} · ${posting.title}（匹配 ${score}）`,
      );
      await this.dependencies.repository.markMatchEventNotified(
        matchEvent.id,
        new Date().toISOString(),
      );
    }
  }
}

export class RecruitmentDigestScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly service: RecruitmentService,
    private readonly intervalMs = 60_000,
  ) {}

  async start(): Promise<void> {
    await this.tick();
    this.timer = setInterval(() => void this.tick(), Math.max(10_000, this.intervalMs));
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.service.runDueDigests();
    } finally {
      this.running = false;
    }
  }
}

export class RecruitmentServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly errors?: unknown,
  ) {
    super(message);
  }
}

function validateMapping(
  fields: Readonly<Record<string, string>>,
  headers?: readonly string[],
): void {
  for (const [field, header] of Object.entries(fields)) {
    if (!importFields.has(field))
      throw new RecruitmentServiceError(422, 'VALIDATION_ERROR', `不支持的目标字段：${field}`);
    if (!header.trim())
      throw new RecruitmentServiceError(422, 'VALIDATION_ERROR', `${field} 的来源列不能为空`);
    if (headers && !headers.includes(header))
      throw new RecruitmentServiceError(422, 'VALIDATION_ERROR', `文件中不存在列：${header}`);
  }
  if (!fields.title || !fields.company) {
    throw new RecruitmentServiceError(422, 'VALIDATION_ERROR', '必须映射 title 和 company');
  }
  if (!fields.externalId && !fields.sourceUrl) {
    throw new RecruitmentServiceError(422, 'VALIDATION_ERROR', '必须映射 externalId 或 sourceUrl');
  }
}

function redactErrorRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([key]) => !/phone|mobile|email|wechat|微信|电话|邮箱/i.test(key))
      .slice(0, 50)
      .map(([key, value]) => [key, String(value ?? '').slice(0, 500)]),
  );
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'recruitment-import';
}

function digestDue(profile: RecruitmentSearchProfile, now: Date): boolean {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: profile.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(now)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const localTime = `${parts.hour}:${parts.minute}`;
  if (localTime < profile.digestTime) return false;
  if (!profile.lastDigestAt) return true;
  const lastParts = Object.fromEntries(
    formatter
      .formatToParts(new Date(profile.lastDigestAt))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${lastParts.year}-${lastParts.month}-${lastParts.day}` < localDate;
}
