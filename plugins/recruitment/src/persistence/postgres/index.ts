import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import {
  recruitmentImportMappingInputSchema,
  recruitmentSearchProfileInputSchema,
  type RecruitmentClusterSuggestion,
  type RecruitmentImportJob,
  type RecruitmentImportMapping,
  type RecruitmentImportMappingInput,
  type RecruitmentJobCluster,
  type RecruitmentPosting,
  type RecruitmentSearchProfile,
  type RecruitmentSearchProfileInput,
  type RecruitmentSource,
  type RecruitmentSourceKey,
  type RecruitmentWorkflowState,
} from '@zhiyun/shared';
import type {
  PostingUpsertResult,
  ReviewedRecruitmentAdapter,
  RecruitmentClusterPage,
  RecruitmentClusterQuery,
  RecruitmentMatchEventRecord,
  RecruitmentRepository,
} from '../../contracts/index.js';
import { buildRecruitmentSearchUrl, type NormalizedPostingInput } from '../../domain/index.js';
import { recruitmentPostgresMigration001 } from '../../migrations/postgres/index.js';
import {
  decodeClusterCursor,
  encodeClusterCursor,
  importJobRow,
  json,
  mappingRow,
  matchEventRow,
  postingRow,
  postingChangeRow,
  profileRow,
  sourceRow,
  suggestionRow,
  type DataRow,
} from '../common.js';

type PostgresClient = ReturnType<typeof postgres>;
const MIGRATION_ID = '001-initial';

export class PostgresRecruitmentRepository implements RecruitmentRepository {
  private readonly sql: PostgresClient;

  constructor(connectionString: string, maxConnections = 5) {
    this.sql = postgres(connectionString, { max: maxConnections });
  }

  async migrate(): Promise<void> {
    const checksum = sha256(recruitmentPostgresMigration001);
    const rows = await this.sql`
      SELECT checksum FROM plugin_migrations
      WHERE plugin_id='recruitment' AND migration_id=${MIGRATION_ID}
    `;
    if (rows[0]) {
      if (rows[0].checksum !== checksum)
        throw new Error('Migration checksum mismatch for recruitment:001-initial');
      return;
    }
    const started = performance.now();
    await this.sql.begin(async (transaction) => {
      await transaction.unsafe(recruitmentPostgresMigration001);
      await transaction`
        INSERT INTO plugin_migrations(
          plugin_id,migration_id,plugin_version,checksum,executed_at,duration_ms,result
        ) VALUES (
          'recruitment',${MIGRATION_ID},'1.0.0',${checksum},${new Date()},
          ${Math.max(0, Math.round(performance.now() - started))},'succeeded'
        )
      `;
    });
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  async listSources(): Promise<RecruitmentSource[]> {
    return (await this.sql`SELECT * FROM recruitment_sources ORDER BY key`).map((row) =>
      sourceRow(row as DataRow),
    );
  }

  async getSource(key: RecruitmentSourceKey): Promise<RecruitmentSource | null> {
    const rows = await this.sql`SELECT * FROM recruitment_sources WHERE key=${key}`;
    return rows[0] ? sourceRow(rows[0] as DataRow) : null;
  }

  async installAuthorizedSource(input: ReviewedRecruitmentAdapter): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`
        UPDATE recruitment_sources SET
          mode='authorized_sync',authorization_status='authorized',live_sync_available=TRUE,
          adapter_version=${input.version},authorization_scope=${input.authorizationScope},
          credential_ref=${input.credentialRef},last_error=NULL
        WHERE key=${input.sourceKey}
      `;
      await transaction`
        UPDATE recruitment_source_bindings SET status='ready' WHERE source_key=${input.sourceKey}
      `;
    });
  }

  async markSourceImported(key: RecruitmentSourceKey, timestamp: string): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`UPDATE recruitment_sources SET last_import_at=${new Date(timestamp)},last_error=NULL WHERE key=${key}`;
      await transaction`UPDATE recruitment_source_bindings SET last_import_at=${new Date(timestamp)} WHERE source_key=${key}`;
    });
  }

  async markSourceSynced(
    key: RecruitmentSourceKey,
    timestamp: string,
    error: string | null,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`
        UPDATE recruitment_sources SET last_sync_at=${new Date(timestamp)},last_error=${error}
        WHERE key=${key}
      `;
      await transaction`
        UPDATE recruitment_source_bindings SET last_run_at=${new Date(timestamp)},
        status=${error ? 'degraded' : 'ready'} WHERE source_key=${key}
      `;
    });
  }

  async listProfiles(): Promise<RecruitmentSearchProfile[]> {
    return (
      await this.sql`SELECT * FROM recruitment_search_profiles ORDER BY updated_at DESC,id DESC`
    ).map((row) => profileRow(row as DataRow));
  }

  async getProfile(id: string): Promise<RecruitmentSearchProfile | null> {
    const rows = await this.sql`SELECT * FROM recruitment_search_profiles WHERE id=${id}`;
    return rows[0] ? profileRow(rows[0] as DataRow) : null;
  }

  async createProfile(input: RecruitmentSearchProfileInput): Promise<RecruitmentSearchProfile> {
    const data = recruitmentSearchProfileInputSchema.parse(input);
    const id = randomUUID();
    const timestamp = new Date();
    await this.sql`
      INSERT INTO recruitment_search_profiles(id,data,revision,last_digest_at,created_at,updated_at)
      VALUES (${id},${this.sql.json(jsonValue(data))},1,NULL,${timestamp},${timestamp})
    `;
    await this.replaceSourceBindings(id, data);
    return (await this.getProfile(id))!;
  }

  async updateProfile(
    id: string,
    input: RecruitmentSearchProfileInput,
    expectedRevision: number,
  ): Promise<RecruitmentSearchProfile | 'revision-conflict' | null> {
    const data = recruitmentSearchProfileInputSchema.parse(input);
    const result = await this.sql.begin(async (transaction) => {
      const selected =
        await transaction`SELECT revision FROM recruitment_search_profiles WHERE id=${id} FOR UPDATE`;
      if (!selected[0]) return 'not-found' as const;
      if (Number(selected[0].revision) !== expectedRevision) return 'revision-conflict' as const;
      await transaction`
        UPDATE recruitment_search_profiles
        SET data=${transaction.json(jsonValue(data))},revision=revision+1,updated_at=${new Date()}
        WHERE id=${id}
      `;
      return 'updated' as const;
    });
    if (result === 'not-found') return null;
    if (result === 'revision-conflict') return result;
    await this.replaceSourceBindings(id, data);
    return this.getProfile(id);
  }

  async deleteProfile(id: string): Promise<boolean> {
    return (
      (await this.sql`DELETE FROM recruitment_search_profiles WHERE id=${id} RETURNING id`).length >
      0
    );
  }

  async markProfileDigested(id: string, timestamp: string): Promise<void> {
    await this.sql`
      UPDATE recruitment_search_profiles SET last_digest_at=${new Date(timestamp)},updated_at=${new Date(timestamp)}
      WHERE id=${id}
    `;
  }

  private async replaceSourceBindings(
    profileId: string,
    profile: RecruitmentSearchProfileInput,
  ): Promise<void> {
    const existing = await this.sql`
      SELECT source_key,task_id,last_run_at,last_import_at
      FROM recruitment_source_bindings WHERE profile_id=${profileId}
    `;
    const previous = new Map(existing.map((row) => [String(row.source_key), row]));
    await this.sql`DELETE FROM recruitment_source_bindings WHERE profile_id=${profileId}`;
    for (const sourceKey of profile.sourceKeys) {
      const row = previous.get(sourceKey);
      const sources = await this.sql`
        SELECT authorization_status,live_sync_available FROM recruitment_sources WHERE key=${sourceKey}
      `;
      const source = sources[0];
      const status =
        source?.authorization_status === 'authorized' && Boolean(source.live_sync_available)
          ? 'ready'
          : 'pending';
      const view = { ...profile, id: profileId } as RecruitmentSearchProfile;
      await this.sql`
        INSERT INTO recruitment_source_bindings(
          profile_id,source_key,task_id,enabled,deep_link,status,last_run_at,last_import_at
        ) VALUES (
          ${profileId},${sourceKey},${row?.task_id ?? null},${profile.enabled},
          ${buildRecruitmentSearchUrl(sourceKey, view)},${status},
          ${row?.last_run_at ?? null},${row?.last_import_at ?? null}
        )
      `;
    }
  }

  async listMappings(sourceKey?: RecruitmentSourceKey): Promise<RecruitmentImportMapping[]> {
    const rows = sourceKey
      ? await this
          .sql`SELECT * FROM recruitment_import_mappings WHERE source_key=${sourceKey} ORDER BY updated_at DESC`
      : await this.sql`SELECT * FROM recruitment_import_mappings ORDER BY updated_at DESC`;
    return rows.map((row) => mappingRow(row as DataRow));
  }

  async getMapping(id: string): Promise<RecruitmentImportMapping | null> {
    const rows = await this.sql`SELECT * FROM recruitment_import_mappings WHERE id=${id}`;
    return rows[0] ? mappingRow(rows[0] as DataRow) : null;
  }

  async findMapping(
    sourceKey: RecruitmentSourceKey,
    headerFingerprint: string,
  ): Promise<RecruitmentImportMapping | null> {
    const rows = await this.sql`
      SELECT * FROM recruitment_import_mappings
      WHERE source_key=${sourceKey} AND header_fingerprint=${headerFingerprint}
      ORDER BY updated_at DESC LIMIT 1
    `;
    return rows[0] ? mappingRow(rows[0] as DataRow) : null;
  }

  async createMapping(input: RecruitmentImportMappingInput): Promise<RecruitmentImportMapping> {
    const data = recruitmentImportMappingInputSchema.parse(input);
    const id = randomUUID();
    const timestamp = new Date();
    await this.sql`
      INSERT INTO recruitment_import_mappings(
        id,source_key,name,header_fingerprint,fields,revision,created_at,updated_at
      ) VALUES (
        ${id},${data.sourceKey},${data.name},${data.headerFingerprint},
        ${this.sql.json(jsonValue(data.fields))},1,${timestamp},${timestamp}
      )
    `;
    return (await this.getMapping(id))!;
  }

  async updateMapping(
    id: string,
    input: RecruitmentImportMappingInput,
    expectedRevision: number,
  ): Promise<RecruitmentImportMapping | 'revision-conflict' | null> {
    const data = recruitmentImportMappingInputSchema.parse(input);
    const result = await this.sql.begin(async (transaction) => {
      const rows =
        await transaction`SELECT revision FROM recruitment_import_mappings WHERE id=${id} FOR UPDATE`;
      if (!rows[0]) return 'not-found' as const;
      if (Number(rows[0].revision) !== expectedRevision) return 'revision-conflict' as const;
      await transaction`
        UPDATE recruitment_import_mappings SET source_key=${data.sourceKey},name=${data.name},
        header_fingerprint=${data.headerFingerprint},fields=${transaction.json(jsonValue(data.fields))},
        revision=revision+1,updated_at=${new Date()} WHERE id=${id}
      `;
      return 'updated' as const;
    });
    if (result === 'not-found') return null;
    if (result === 'revision-conflict') return result;
    return this.getMapping(id);
  }

  async deleteMapping(id: string): Promise<boolean> {
    return (
      (await this.sql`DELETE FROM recruitment_import_mappings WHERE id=${id} RETURNING id`).length >
      0
    );
  }

  async createImportJob(input: {
    sourceKey: RecruitmentSourceKey;
    searchProfileId: string;
    mappingId: string | null;
    mappingRevision: number | null;
    filename: string;
    sha256: string;
    totalRows: number;
  }): Promise<RecruitmentImportJob> {
    const id = randomUUID();
    await this.sql`
      INSERT INTO recruitment_import_jobs(
        id,source_key,search_profile_id,mapping_id,mapping_revision,filename,sha256,status,total_rows,started_at
      ) VALUES (
        ${id},${input.sourceKey},${input.searchProfileId},${input.mappingId},${input.mappingRevision},
        ${input.filename},${input.sha256},'running',${input.totalRows},${new Date()}
      )
    `;
    return (await this.getImportJob(id))!;
  }

  async finishImportJob(
    id: string,
    input: Pick<
      RecruitmentImportJob,
      | 'status'
      | 'importedRows'
      | 'createdRows'
      | 'updatedRows'
      | 'unchangedRows'
      | 'errorRows'
      | 'errorArtifactId'
      | 'errorSummary'
    >,
  ): Promise<RecruitmentImportJob> {
    await this.sql`
      UPDATE recruitment_import_jobs SET status=${input.status},
      total_rows=${input.importedRows + input.errorRows},imported_rows=${input.importedRows},
      created_rows=${input.createdRows},updated_rows=${input.updatedRows},unchanged_rows=${input.unchangedRows},
      error_rows=${input.errorRows},error_artifact_id=${input.errorArtifactId},
      error_summary=${this.sql.json(jsonValue(input.errorSummary))},completed_at=${new Date()}
      WHERE id=${id}
    `;
    const job = await this.getImportJob(id);
    if (!job) throw new Error('Recruitment import job disappeared');
    return job;
  }

  async getImportJob(id: string): Promise<RecruitmentImportJob | null> {
    const rows = await this.sql`SELECT * FROM recruitment_import_jobs WHERE id=${id}`;
    return rows[0] ? importJobRow(rows[0] as DataRow) : null;
  }

  async getImportErrors(
    id: string,
  ): Promise<Array<{ row: number; message: string; data?: unknown }>> {
    const rows = await this.sql`SELECT errors FROM recruitment_import_jobs WHERE id=${id}`;
    return rows[0]
      ? (json(rows[0].errors) as Array<{ row: number; message: string; data?: unknown }>)
      : [];
  }

  async saveImportErrors(
    id: string,
    errors: Array<{ row: number; message: string; data?: unknown }>,
  ): Promise<void> {
    const summaries = errors.slice(0, 100).map(({ row, message }) => ({ row, message }));
    await this
      .sql`UPDATE recruitment_import_jobs SET errors=${this.sql.json(jsonValue(summaries))} WHERE id=${id}`;
  }

  async upsertPosting(
    input: NormalizedPostingInput,
    provenance: { importJobId: string; importRow: number },
  ): Promise<PostingUpsertResult> {
    return this.sql.begin(async (transaction) => {
      const rows = await transaction`
        SELECT * FROM recruitment_postings
        WHERE source_key=${input.sourceKey} AND stable_key=${input.stableKey} FOR UPDATE
      `;
      const existing = rows[0] as DataRow | undefined;
      const timestamp = new Date();
      if (!existing) {
        const id = randomUUID();
        await transaction`
          INSERT INTO recruitment_postings(
            id,source_key,stable_key,external_id,source_url,title,company,location,salary_raw,
            salary_min_monthly,salary_max_monthly,salary_months,description,published_at,expires_at,
            experience,education,employment_type,skills,status,normalized_title,normalized_company,
            normalized_location,content_hash,first_seen_at,last_seen_at,import_job_id,import_row,normalizer_version
          ) VALUES (
            ${id},${input.sourceKey},${input.stableKey},${input.externalId},${input.sourceUrl},${input.title},
            ${input.company},${input.location},${input.salaryRaw},${input.salaryMinMonthly},${input.salaryMaxMonthly},
            ${input.salaryMonths},${input.description},${dateOrNull(input.publishedAt)},${dateOrNull(input.expiresAt)},
            ${input.experience},${input.education},${input.employmentType},${transaction.json(jsonValue(input.skills))},
            ${input.status},${input.normalizedTitle},${input.normalizedCompany},${input.normalizedLocation},
            ${input.contentHash},${timestamp},${timestamp},${provenance.importJobId},${provenance.importRow},${input.normalizerVersion}
          )
        `;
        const inserted = await transaction`SELECT * FROM recruitment_postings WHERE id=${id}`;
        return { posting: postingRow(inserted[0] as DataRow), change: 'created' as const };
      }
      const current = postingRow(existing);
      const reopened = ['closed', 'stale'].includes(current.status) && input.status === 'active';
      const status =
        reopened || (current.status === 'reopened' && input.status === 'active')
          ? 'reopened'
          : input.status;
      const changed = current.contentHash !== input.contentHash || current.status !== status;
      await transaction`
        UPDATE recruitment_postings SET
          external_id=${input.externalId},source_url=${input.sourceUrl},title=${input.title},company=${input.company},
          location=${input.location},salary_raw=${input.salaryRaw},salary_min_monthly=${input.salaryMinMonthly},
          salary_max_monthly=${input.salaryMaxMonthly},salary_months=${input.salaryMonths},description=${input.description},
          published_at=${dateOrNull(input.publishedAt)},expires_at=${dateOrNull(input.expiresAt)},experience=${input.experience},
          education=${input.education},employment_type=${input.employmentType},skills=${transaction.json(jsonValue(input.skills))},
          status=${status},normalized_title=${input.normalizedTitle},normalized_company=${input.normalizedCompany},
          normalized_location=${input.normalizedLocation},content_hash=${input.contentHash},last_seen_at=${timestamp},
          import_job_id=${provenance.importJobId},import_row=${provenance.importRow},normalizer_version=${input.normalizerVersion}
        WHERE id=${current.id}
      `;
      if (changed) {
        await transaction`
          INSERT INTO recruitment_posting_changes(
            id,posting_id,import_job_id,previous_hash,current_hash,changed_fields,created_at
          ) VALUES (
            ${randomUUID()},${current.id},${provenance.importJobId},${current.contentHash},${input.contentHash},
            ${transaction.json(jsonValue(postingChangedFields(current, input, status)))},${timestamp}
          )
        `;
      }
      const updated = await transaction`SELECT * FROM recruitment_postings WHERE id=${current.id}`;
      return {
        posting: postingRow(updated[0] as DataRow),
        change: reopened
          ? ('reopened' as const)
          : changed
            ? ('updated' as const)
            : ('unchanged' as const),
      };
    });
  }

  async getPosting(id: string): Promise<RecruitmentPosting | null> {
    const rows = await this.sql`SELECT * FROM recruitment_postings WHERE id=${id}`;
    return rows[0] ? postingRow(rows[0] as DataRow) : null;
  }

  async completeAuthorizedSnapshot(
    sourceKey: RecruitmentSourceKey,
    profileId: string,
    seenPostingIds: readonly string[],
    timestamp: string,
  ): Promise<void> {
    const seen = new Set(seenPostingIds);
    const snapshotAt = Date.parse(timestamp);
    await this.sql.begin(async (transaction) => {
      for (const postingId of seen) {
        await transaction`
          INSERT INTO recruitment_snapshot_presence(
            source_key,profile_id,posting_id,missing_count,first_missing_at,last_seen_at
          ) VALUES (${sourceKey},${profileId},${postingId},0,NULL,${new Date(timestamp)})
          ON CONFLICT(source_key,profile_id,posting_id) DO UPDATE SET
          missing_count=0,first_missing_at=NULL,last_seen_at=EXCLUDED.last_seen_at
        `;
      }
      const presences = await transaction`
        SELECT posting_id FROM recruitment_snapshot_presence
        WHERE source_key=${sourceKey} AND profile_id=${profileId}
      `;
      for (const row of presences) {
        const postingId = String(row.posting_id);
        if (seen.has(postingId)) continue;
        await transaction`
          UPDATE recruitment_snapshot_presence SET
          missing_count=missing_count+1,first_missing_at=COALESCE(first_missing_at,${new Date(timestamp)})
          WHERE source_key=${sourceKey} AND profile_id=${profileId} AND posting_id=${postingId}
        `;
        const all = await transaction`
          SELECT missing_count,first_missing_at
          FROM recruitment_snapshot_presence WHERE posting_id=${postingId}
        `;
        if (all.some((presence) => Number(presence.missing_count) === 0)) continue;
        const firstMissingAt = Math.min(
          ...all.map((presence) => new Date(String(presence.first_missing_at)).getTime()),
        );
        const status =
          all.every((presence) => Number(presence.missing_count) >= 3) &&
          snapshotAt - firstMissingAt >= 7 * 86_400_000
            ? 'closed'
            : 'stale';
        const postings = await transaction`
          SELECT status,content_hash FROM recruitment_postings WHERE id=${postingId} FOR UPDATE
        `;
        const posting = postings[0];
        if (!posting || posting.status === status || posting.status === 'closed') continue;
        await transaction`UPDATE recruitment_postings SET status=${status} WHERE id=${postingId}`;
        await transaction`
          INSERT INTO recruitment_posting_changes(
            id,posting_id,import_job_id,previous_hash,current_hash,changed_fields,created_at
          ) VALUES (
            ${randomUUID()},${postingId},NULL,${posting.content_hash},${posting.content_hash},
            ${transaction.json(jsonValue(['status']))},${new Date(timestamp)}
          )
        `;
      }
    });
  }

  async listCandidateClusters(posting: RecruitmentPosting): Promise<RecruitmentJobCluster[]> {
    const rows = await this.sql`
      SELECT DISTINCT c.id,c.updated_at FROM recruitment_clusters c
      JOIN recruitment_cluster_members cm ON cm.cluster_id=c.id
      JOIN recruitment_postings p ON p.id=cm.posting_id
      WHERE p.normalized_company=${posting.normalizedCompany}
      ORDER BY c.updated_at DESC LIMIT 100
    `;
    const clusters = await Promise.all(rows.map((row) => this.getCluster(String(row.id))));
    return clusters.filter((item): item is RecruitmentJobCluster => Boolean(item));
  }

  async createCluster(posting: RecruitmentPosting): Promise<RecruitmentJobCluster> {
    const id = randomUUID();
    const timestamp = new Date();
    await this.sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO recruitment_clusters(
          id,representative_posting_id,title,company,location,confidence,first_seen_at,last_seen_at,created_at,updated_at
        ) VALUES (
          ${id},${posting.id},${posting.title},${posting.company},${posting.location},1,
          ${new Date(posting.firstSeenAt)},${new Date(posting.lastSeenAt)},${timestamp},${timestamp}
        )
      `;
      await transaction`
        INSERT INTO recruitment_cluster_members(cluster_id,posting_id,confidence,assignment_source,locked,created_at)
        VALUES (${id},${posting.id},1,'automatic',FALSE,${timestamp})
      `;
      await transaction`
        INSERT INTO recruitment_user_states(cluster_id,state,note,created_at,updated_at)
        VALUES (${id},'untracked','',${timestamp},${timestamp})
      `;
    });
    return (await this.getCluster(id))!;
  }

  async addPostingToCluster(
    clusterId: string,
    posting: RecruitmentPosting,
    confidence: number,
    assignmentSource: 'automatic' | 'manual' = 'automatic',
    locked = false,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const rows =
        await transaction`SELECT cluster_id,locked FROM recruitment_cluster_members WHERE posting_id=${posting.id} FOR UPDATE`;
      const current = rows[0];
      if (current && (Boolean(current.locked) || String(current.cluster_id) === clusterId)) return;
      if (current)
        await transaction`DELETE FROM recruitment_cluster_members WHERE posting_id=${posting.id}`;
      await transaction`
        INSERT INTO recruitment_cluster_members(cluster_id,posting_id,confidence,assignment_source,locked,created_at)
        VALUES (${clusterId},${posting.id},${confidence},${assignmentSource},${locked},${new Date()})
      `;
      await transaction`
        UPDATE recruitment_clusters SET confidence=GREATEST(confidence,${confidence}),
        last_seen_at=GREATEST(last_seen_at,${new Date(posting.lastSeenAt)}),updated_at=${new Date()}
        WHERE id=${clusterId}
      `;
    });
  }

  async addClusterSuggestion(suggestion: RecruitmentClusterSuggestion): Promise<void> {
    await this.sql`
      INSERT INTO recruitment_cluster_suggestions(cluster_id,candidate_cluster_id,score,evidence,created_at)
      VALUES (
        ${suggestion.clusterId},${suggestion.candidateClusterId},${suggestion.score},
        ${this.sql.json(jsonValue(suggestion.evidence))},${new Date()}
      ) ON CONFLICT(cluster_id,candidate_cluster_id) DO UPDATE SET
      score=EXCLUDED.score,evidence=EXCLUDED.evidence
    `;
  }

  async getCluster(id: string, profileId?: string): Promise<RecruitmentJobCluster | null> {
    const clusterRows = await this.sql`SELECT * FROM recruitment_clusters WHERE id=${id}`;
    const cluster = clusterRows[0] as DataRow | undefined;
    if (!cluster) return null;
    const postingRows = await this.sql`
      SELECT p.* FROM recruitment_postings p
      JOIN recruitment_cluster_members cm ON cm.posting_id=p.id
      WHERE cm.cluster_id=${id} ORDER BY cm.confidence DESC,p.last_seen_at DESC
    `;
    const stateRows = await this
      .sql`SELECT state,note FROM recruitment_user_states WHERE cluster_id=${id}`;
    const matchRows = profileId
      ? await this.sql`
          SELECT pp.score,pp.reasons FROM recruitment_posting_profiles pp
          JOIN recruitment_cluster_members cm ON cm.posting_id=pp.posting_id
          WHERE cm.cluster_id=${id} AND pp.profile_id=${profileId}
          ORDER BY pp.score DESC LIMIT 1
        `
      : await this.sql`
          SELECT pp.score,pp.reasons FROM recruitment_posting_profiles pp
          JOIN recruitment_cluster_members cm ON cm.posting_id=pp.posting_id
          WHERE cm.cluster_id=${id} ORDER BY pp.score DESC LIMIT 1
        `;
    const suggestionRows = await this.sql`
      SELECT * FROM recruitment_cluster_suggestions WHERE cluster_id=${id} ORDER BY score DESC
    `;
    const changeRows = await this.sql`
      SELECT pc.* FROM recruitment_posting_changes pc
      JOIN recruitment_cluster_members cm ON cm.posting_id=pc.posting_id
      WHERE cm.cluster_id=${id} ORDER BY pc.created_at DESC LIMIT 100
    `;
    const state = stateRows[0];
    const match = matchRows[0];
    return {
      id: String(cluster.id),
      representativePostingId: String(cluster.representative_posting_id),
      title: String(cluster.title),
      company: String(cluster.company),
      location: cluster.location === null ? null : String(cluster.location),
      confidence: Number(cluster.confidence),
      firstSeenAt: new Date(String(cluster.first_seen_at)).toISOString(),
      lastSeenAt: new Date(String(cluster.last_seen_at)).toISOString(),
      postings: postingRows.map((row) => postingRow(row as DataRow)),
      workflowState: (state?.state ?? 'untracked') as RecruitmentWorkflowState,
      note: String(state?.note ?? ''),
      matchScore: match ? Number(match.score) : null,
      matchReasons: match ? (json(match.reasons) as string[]) : [],
      suggestions: suggestionRows.map((row) => suggestionRow(row as DataRow)),
      changes: changeRows.map((row) => postingChangeRow(row as DataRow)),
    };
  }

  async listClusters(query: RecruitmentClusterQuery): Promise<RecruitmentClusterPage> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const cursor = query.cursor ? decodeClusterCursor(query.cursor) : null;
    const profileId = query.profileId ?? null;
    const sourceKey = query.sourceKey ?? null;
    const workflowState = query.workflowState ?? null;
    const city = query.city ?? null;
    const keyword = query.keyword ?? null;
    const salaryMin = query.salaryMin ?? null;
    const salaryMax = query.salaryMax ?? null;
    const publishedAfter = query.publishedAfter ? new Date(query.publishedAfter) : null;
    const publishedBefore = query.publishedBefore ? new Date(query.publishedBefore) : null;
    const includeArchived = Boolean(query.includeArchived);
    const cutoff = new Date(Date.now() - 180 * 86_400_000);
    const cursorAt = cursor ? new Date(cursor.updatedAt) : null;
    const cursorId = cursor?.id ?? null;
    const rows = await this.sql`
      SELECT DISTINCT c.id,c.updated_at FROM recruitment_clusters c
      LEFT JOIN recruitment_user_states us ON us.cluster_id=c.id
      WHERE (${profileId}::text IS NULL OR EXISTS (
        SELECT 1 FROM recruitment_cluster_members cm
        JOIN recruitment_posting_profiles pp ON pp.posting_id=cm.posting_id
        WHERE cm.cluster_id=c.id AND pp.profile_id=${profileId}
      ))
      AND (${sourceKey}::text IS NULL OR EXISTS (
        SELECT 1 FROM recruitment_cluster_members cm JOIN recruitment_postings p ON p.id=cm.posting_id
        WHERE cm.cluster_id=c.id AND p.source_key=${sourceKey}
      ))
      AND (${workflowState}::text IS NULL OR COALESCE(us.state,'untracked')=${workflowState})
      AND (${city}::text IS NULL OR EXISTS (
        SELECT 1 FROM recruitment_cluster_members cm JOIN recruitment_postings p ON p.id=cm.posting_id
        WHERE cm.cluster_id=c.id AND p.normalized_location LIKE ${`%${city ?? ''}%`}
      ))
      AND (${keyword}::text IS NULL OR c.title LIKE ${`%${keyword ?? ''}%`} OR c.company LIKE ${`%${keyword ?? ''}%`} OR EXISTS (
        SELECT 1 FROM recruitment_cluster_members cm JOIN recruitment_postings p ON p.id=cm.posting_id
        WHERE cm.cluster_id=c.id AND p.description LIKE ${`%${keyword ?? ''}%`}
      ))
      AND (${salaryMin}::integer IS NULL OR EXISTS (
        SELECT 1 FROM recruitment_cluster_members cm JOIN recruitment_postings p ON p.id=cm.posting_id
        WHERE cm.cluster_id=c.id AND p.salary_max_monthly>=${salaryMin}
      ))
      AND (${salaryMax}::integer IS NULL OR EXISTS (
        SELECT 1 FROM recruitment_cluster_members cm JOIN recruitment_postings p ON p.id=cm.posting_id
        WHERE cm.cluster_id=c.id AND p.salary_min_monthly<=${salaryMax}
      ))
      AND (${publishedAfter}::timestamptz IS NULL OR EXISTS (
        SELECT 1 FROM recruitment_cluster_members cm JOIN recruitment_postings p ON p.id=cm.posting_id
        WHERE cm.cluster_id=c.id AND p.published_at>=${publishedAfter}
      ))
      AND (${publishedBefore}::timestamptz IS NULL OR EXISTS (
        SELECT 1 FROM recruitment_cluster_members cm JOIN recruitment_postings p ON p.id=cm.posting_id
        WHERE cm.cluster_id=c.id AND p.published_at<=${publishedBefore}
      ))
      AND (${includeArchived} OR EXISTS (
        SELECT 1 FROM recruitment_cluster_members cm JOIN recruitment_postings p ON p.id=cm.posting_id
        WHERE cm.cluster_id=c.id AND (p.status<>'closed' OR p.last_seen_at>=${cutoff})
      ))
      AND (${cursorAt}::timestamptz IS NULL OR c.updated_at<${cursorAt} OR (c.updated_at=${cursorAt} AND c.id<${cursorId}))
      ORDER BY c.updated_at DESC,c.id DESC LIMIT ${limit + 1}
    `;
    const selected = rows.slice(0, limit);
    const items = (
      await Promise.all(selected.map((row) => this.getCluster(String(row.id), query.profileId)))
    ).filter((item): item is RecruitmentJobCluster => Boolean(item));
    const last = selected.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? encodeClusterCursor(new Date(String(last.updated_at)).toISOString(), String(last.id))
          : null,
    };
  }

  async upsertPostingProfile(input: {
    postingId: string;
    profileId: string;
    score: number;
    reasons: string[];
  }): Promise<void> {
    const timestamp = new Date();
    await this.sql`
      INSERT INTO recruitment_posting_profiles(posting_id,profile_id,score,reasons,matched_at,updated_at)
      VALUES (
        ${input.postingId},${input.profileId},${input.score},${this.sql.json(jsonValue(input.reasons))},${timestamp},${timestamp}
      ) ON CONFLICT(posting_id,profile_id) DO UPDATE SET
      score=EXCLUDED.score,reasons=EXCLUDED.reasons,updated_at=EXCLUDED.updated_at
    `;
  }

  async deletePostingProfile(postingId: string, profileId: string): Promise<void> {
    await this.sql`
      DELETE FROM recruitment_posting_profiles
      WHERE posting_id=${postingId} AND profile_id=${profileId}
    `;
  }

  async setWorkflowState(
    clusterId: string,
    state: RecruitmentWorkflowState,
    note: string,
  ): Promise<RecruitmentJobCluster | null> {
    const timestamp = new Date();
    const rows = await this.sql`
      UPDATE recruitment_user_states SET state=${state},note=${note},
      applied_at=CASE WHEN ${state}='applied' THEN COALESCE(applied_at,${timestamp}) ELSE applied_at END,
      interviewing_at=CASE WHEN ${state}='interviewing' THEN COALESCE(interviewing_at,${timestamp}) ELSE interviewing_at END,
      updated_at=${timestamp} WHERE cluster_id=${clusterId} RETURNING cluster_id
    `;
    return rows.length ? this.getCluster(clusterId) : null;
  }

  async mergeClusters(
    targetClusterId: string,
    sourceClusterIds: readonly string[],
  ): Promise<RecruitmentJobCluster | null> {
    const target = await this.getCluster(targetClusterId);
    if (!target) return null;
    await this.sql.begin(async (transaction) => {
      for (const sourceId of [...new Set(sourceClusterIds)].filter(
        (id) => id !== targetClusterId,
      )) {
        await transaction`
          UPDATE recruitment_cluster_members SET cluster_id=${targetClusterId},assignment_source='manual',locked=TRUE
          WHERE cluster_id=${sourceId}
        `;
        await transaction`DELETE FROM recruitment_clusters WHERE id=${sourceId}`;
      }
      await transaction`
        UPDATE recruitment_cluster_members SET assignment_source='manual',locked=TRUE WHERE cluster_id=${targetClusterId}
      `;
      await transaction`
        UPDATE recruitment_clusters SET confidence=1,updated_at=${new Date()} WHERE id=${targetClusterId}
      `;
    });
    return this.getCluster(targetClusterId);
  }

  async splitCluster(
    clusterId: string,
    postingIds: readonly string[],
  ): Promise<RecruitmentJobCluster | null> {
    const ids = [...new Set(postingIds)];
    if (ids.length === 0) return null;
    const rows = await this.sql`
      SELECT p.* FROM recruitment_postings p JOIN recruitment_cluster_members cm ON cm.posting_id=p.id
      WHERE cm.cluster_id=${clusterId}
    `;
    const selected = rows
      .map((row) => postingRow(row as DataRow))
      .filter((posting) => ids.includes(posting.id));
    if (selected.length === 0 || selected.length === rows.length) return null;
    const representative = selected[0]!;
    const newId = randomUUID();
    const timestamp = new Date();
    await this.sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO recruitment_clusters(
          id,representative_posting_id,title,company,location,confidence,first_seen_at,last_seen_at,created_at,updated_at
        ) VALUES (
          ${newId},${representative.id},${representative.title},${representative.company},${representative.location},1,
          ${new Date(representative.firstSeenAt)},${new Date(representative.lastSeenAt)},${timestamp},${timestamp}
        )
      `;
      await transaction`
        UPDATE recruitment_cluster_members SET cluster_id=${newId},confidence=1,assignment_source='manual',locked=TRUE
        WHERE posting_id IN ${transaction(ids)} AND cluster_id=${clusterId}
      `;
      await transaction`
        INSERT INTO recruitment_user_states(cluster_id,state,note,created_at,updated_at)
        VALUES (${newId},'untracked','',${timestamp},${timestamp})
      `;
      await transaction`
        UPDATE recruitment_cluster_members SET assignment_source='manual',locked=TRUE WHERE cluster_id=${clusterId}
      `;
      await transaction`UPDATE recruitment_clusters SET updated_at=${timestamp} WHERE id=${clusterId}`;
    });
    return this.getCluster(newId);
  }

  async createMatchEvent(
    input: Omit<RecruitmentMatchEventRecord, 'id' | 'createdAt' | 'notifiedAt' | 'digestedAt'>,
  ): Promise<RecruitmentMatchEventRecord | null> {
    const id = randomUUID();
    const rows = await this.sql`
      INSERT INTO recruitment_match_events(
        id,profile_id,cluster_id,posting_id,event_type,content_hash,score,reasons,created_at
      ) VALUES (
        ${id},${input.profileId},${input.clusterId},${input.postingId},${input.eventType},${input.contentHash},
        ${input.score},${this.sql.json(jsonValue(input.reasons))},${new Date()}
      ) ON CONFLICT(profile_id,cluster_id,event_type,content_hash) DO NOTHING RETURNING *
    `;
    return rows[0] ? matchEventRow(rows[0] as DataRow) : null;
  }

  async markMatchEventNotified(id: string, timestamp: string): Promise<void> {
    await this.sql`
      UPDATE recruitment_match_events SET notified_at=COALESCE(notified_at,${new Date(timestamp)}) WHERE id=${id}
    `;
  }

  async listUndigestedEvents(profileId: string): Promise<RecruitmentMatchEventRecord[]> {
    return (
      await this.sql`
        SELECT * FROM recruitment_match_events WHERE profile_id=${profileId} AND digested_at IS NULL
        ORDER BY created_at,id
      `
    ).map((row) => matchEventRow(row as DataRow));
  }

  async markEventsDigested(profileId: string, timestamp: string): Promise<number> {
    return (
      await this.sql`
        UPDATE recruitment_match_events SET digested_at=${new Date(timestamp)}
        WHERE profile_id=${profileId} AND digested_at IS NULL RETURNING id
      `
    ).length;
  }
}

function dateOrNull(value: string | null): Date | null {
  return value ? new Date(value) : null;
}

function postingChangedFields(
  current: RecruitmentPosting,
  next: NormalizedPostingInput,
  status: RecruitmentPosting['status'],
): string[] {
  const fields: Array<keyof NormalizedPostingInput> = [
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
  ];
  const changed = fields.filter(
    (field) => JSON.stringify(current[field]) !== JSON.stringify(next[field]),
  );
  if (current.status !== status) changed.push('status');
  return changed;
}

function jsonValue(value: unknown): Parameters<PostgresClient['json']>[0] {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Value is not JSON serializable');
  return JSON.parse(serialized) as Parameters<PostgresClient['json']>[0];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
