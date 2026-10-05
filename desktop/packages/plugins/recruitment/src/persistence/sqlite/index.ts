import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
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
  RecruitmentClusterPage,
  RecruitmentClusterQuery,
  RecruitmentMatchEventRecord,
  RecruitmentRepository,
  PostingUpsertResult,
  ReviewedRecruitmentAdapter,
} from '../../contracts/index.js';
import { buildRecruitmentSearchUrl, type NormalizedPostingInput } from '../../domain/index.js';
import { recruitmentSqliteMigration001 } from '../../migrations/sqlite/index.js';
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

const MIGRATION_ID = '001-initial';

export class SqliteRecruitmentRepository implements RecruitmentRepository {
  private readonly sqlite: Database.Database;

  constructor(filePath: string) {
    this.sqlite = new Database(filePath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
  }

  async migrate(): Promise<void> {
    const checksum = sha256(recruitmentSqliteMigration001);
    const existing = this.sqlite
      .prepare('SELECT checksum FROM plugin_migrations WHERE plugin_id=? AND migration_id=?')
      .get('recruitment', MIGRATION_ID) as DataRow | undefined;
    if (existing) {
      if (existing.checksum !== checksum)
        throw new Error('Migration checksum mismatch for recruitment:001-initial');
      return;
    }
    const started = performance.now();
    this.sqlite.transaction(() => {
      this.sqlite.exec(recruitmentSqliteMigration001);
      this.sqlite
        .prepare(
          `INSERT INTO plugin_migrations(
             plugin_id,migration_id,plugin_version,checksum,executed_at,duration_ms,result
           ) VALUES ('recruitment',?,'1.0.0',?,?,?,'succeeded')`,
        )
        .run(
          MIGRATION_ID,
          checksum,
          new Date().toISOString(),
          Math.max(0, Math.round(performance.now() - started)),
        );
    })();
  }

  async close(): Promise<void> {
    if (this.sqlite.open) this.sqlite.close();
  }

  async listSources(): Promise<RecruitmentSource[]> {
    return (
      this.sqlite.prepare('SELECT * FROM recruitment_sources ORDER BY key').all() as DataRow[]
    ).map(sourceRow);
  }

  async getSource(key: RecruitmentSourceKey): Promise<RecruitmentSource | null> {
    const row = this.sqlite.prepare('SELECT * FROM recruitment_sources WHERE key=?').get(key) as
      DataRow | undefined;
    return row ? sourceRow(row) : null;
  }

  async installAuthorizedSource(input: ReviewedRecruitmentAdapter): Promise<void> {
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          `UPDATE recruitment_sources SET
             mode='authorized_sync',authorization_status='authorized',live_sync_available=1,
             adapter_version=?,authorization_scope=?,credential_ref=?,last_error=NULL
           WHERE key=?`,
        )
        .run(input.version, input.authorizationScope, input.credentialRef, input.sourceKey);
      this.sqlite
        .prepare("UPDATE recruitment_source_bindings SET status='ready' WHERE source_key=?")
        .run(input.sourceKey);
    })();
  }

  async markSourceImported(key: RecruitmentSourceKey, timestamp: string): Promise<void> {
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare('UPDATE recruitment_sources SET last_import_at=?,last_error=NULL WHERE key=?')
        .run(timestamp, key);
      this.sqlite
        .prepare('UPDATE recruitment_source_bindings SET last_import_at=? WHERE source_key=?')
        .run(timestamp, key);
    })();
  }

  async markSourceSynced(
    key: RecruitmentSourceKey,
    timestamp: string,
    error: string | null,
  ): Promise<void> {
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare('UPDATE recruitment_sources SET last_sync_at=?,last_error=? WHERE key=?')
        .run(timestamp, error, key);
      this.sqlite
        .prepare('UPDATE recruitment_source_bindings SET last_run_at=?,status=? WHERE source_key=?')
        .run(timestamp, error ? 'degraded' : 'ready', key);
    })();
  }

  async listProfiles(): Promise<RecruitmentSearchProfile[]> {
    return (
      this.sqlite
        .prepare('SELECT * FROM recruitment_search_profiles ORDER BY updated_at DESC,id DESC')
        .all() as DataRow[]
    ).map(profileRow);
  }

  async getProfile(id: string): Promise<RecruitmentSearchProfile | null> {
    const row = this.sqlite
      .prepare('SELECT * FROM recruitment_search_profiles WHERE id=?')
      .get(id) as DataRow | undefined;
    return row ? profileRow(row) : null;
  }

  async createProfile(input: RecruitmentSearchProfileInput): Promise<RecruitmentSearchProfile> {
    const data = recruitmentSearchProfileInputSchema.parse(input);
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          'INSERT INTO recruitment_search_profiles(id,data,revision,last_digest_at,created_at,updated_at) VALUES (?,?,1,NULL,?,?)',
        )
        .run(id, JSON.stringify(data), timestamp, timestamp);
      this.replaceSourceBindings(id, data, timestamp);
    })();
    return (await this.getProfile(id))!;
  }

  async updateProfile(
    id: string,
    input: RecruitmentSearchProfileInput,
    expectedRevision: number,
  ): Promise<RecruitmentSearchProfile | 'revision-conflict' | null> {
    const data = recruitmentSearchProfileInputSchema.parse(input);
    const result = this.sqlite.transaction(() => {
      const current = this.sqlite
        .prepare('SELECT revision FROM recruitment_search_profiles WHERE id=?')
        .get(id) as DataRow | undefined;
      if (!current) return 'not-found' as const;
      if (Number(current.revision) !== expectedRevision) return 'revision-conflict' as const;
      const timestamp = new Date().toISOString();
      this.sqlite
        .prepare(
          'UPDATE recruitment_search_profiles SET data=?,revision=revision+1,updated_at=? WHERE id=?',
        )
        .run(JSON.stringify(data), timestamp, id);
      this.replaceSourceBindings(id, data, timestamp);
      return 'updated' as const;
    })();
    if (result === 'not-found') return null;
    if (result === 'revision-conflict') return result;
    return this.getProfile(id);
  }

  async deleteProfile(id: string): Promise<boolean> {
    return (
      this.sqlite.prepare('DELETE FROM recruitment_search_profiles WHERE id=?').run(id).changes > 0
    );
  }

  async markProfileDigested(id: string, timestamp: string): Promise<void> {
    this.sqlite
      .prepare('UPDATE recruitment_search_profiles SET last_digest_at=?,updated_at=? WHERE id=?')
      .run(timestamp, timestamp, id);
  }

  private replaceSourceBindings(
    profileId: string,
    profile: RecruitmentSearchProfileInput,
    timestamp: string,
  ): void {
    const existing = new Map(
      (
        this.sqlite
          .prepare(
            'SELECT source_key,task_id,last_run_at,last_import_at FROM recruitment_source_bindings WHERE profile_id=?',
          )
          .all(profileId) as DataRow[]
      ).map((row) => [String(row.source_key), row]),
    );
    this.sqlite
      .prepare('DELETE FROM recruitment_source_bindings WHERE profile_id=?')
      .run(profileId);
    for (const sourceKey of profile.sourceKeys) {
      const previous = existing.get(sourceKey);
      const source = this.sqlite
        .prepare(
          'SELECT authorization_status,live_sync_available FROM recruitment_sources WHERE key=?',
        )
        .get(sourceKey) as DataRow;
      const status =
        source.authorization_status === 'authorized' && Boolean(source.live_sync_available)
          ? 'ready'
          : 'pending';
      const view = { ...profile, id: profileId } as RecruitmentSearchProfile;
      this.sqlite
        .prepare(
          `INSERT INTO recruitment_source_bindings(
             profile_id,source_key,task_id,enabled,deep_link,status,last_run_at,last_import_at
           ) VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(
          profileId,
          sourceKey,
          previous?.task_id ?? null,
          profile.enabled ? 1 : 0,
          buildRecruitmentSearchUrl(sourceKey, view),
          status,
          previous?.last_run_at ?? null,
          previous?.last_import_at ?? null,
        );
    }
    void timestamp;
  }

  async listMappings(sourceKey?: RecruitmentSourceKey): Promise<RecruitmentImportMapping[]> {
    const rows = sourceKey
      ? (this.sqlite
          .prepare(
            'SELECT * FROM recruitment_import_mappings WHERE source_key=? ORDER BY updated_at DESC',
          )
          .all(sourceKey) as DataRow[])
      : (this.sqlite
          .prepare('SELECT * FROM recruitment_import_mappings ORDER BY updated_at DESC')
          .all() as DataRow[]);
    return rows.map(mappingRow);
  }

  async getMapping(id: string): Promise<RecruitmentImportMapping | null> {
    const row = this.sqlite
      .prepare('SELECT * FROM recruitment_import_mappings WHERE id=?')
      .get(id) as DataRow | undefined;
    return row ? mappingRow(row) : null;
  }

  async findMapping(
    sourceKey: RecruitmentSourceKey,
    headerFingerprint: string,
  ): Promise<RecruitmentImportMapping | null> {
    const row = this.sqlite
      .prepare(
        'SELECT * FROM recruitment_import_mappings WHERE source_key=? AND header_fingerprint=? ORDER BY updated_at DESC LIMIT 1',
      )
      .get(sourceKey, headerFingerprint) as DataRow | undefined;
    return row ? mappingRow(row) : null;
  }

  async createMapping(input: RecruitmentImportMappingInput): Promise<RecruitmentImportMapping> {
    const data = recruitmentImportMappingInputSchema.parse(input);
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO recruitment_import_mappings(
           id,source_key,name,header_fingerprint,fields,revision,created_at,updated_at
         ) VALUES (?,?,?,?,?,1,?,?)`,
      )
      .run(
        id,
        data.sourceKey,
        data.name,
        data.headerFingerprint,
        JSON.stringify(data.fields),
        timestamp,
        timestamp,
      );
    return (await this.getMapping(id))!;
  }

  async updateMapping(
    id: string,
    input: RecruitmentImportMappingInput,
    expectedRevision: number,
  ): Promise<RecruitmentImportMapping | 'revision-conflict' | null> {
    const data = recruitmentImportMappingInputSchema.parse(input);
    const current = this.sqlite
      .prepare('SELECT revision FROM recruitment_import_mappings WHERE id=?')
      .get(id) as DataRow | undefined;
    if (!current) return null;
    if (Number(current.revision) !== expectedRevision) return 'revision-conflict';
    this.sqlite
      .prepare(
        'UPDATE recruitment_import_mappings SET source_key=?,name=?,header_fingerprint=?,fields=?,revision=revision+1,updated_at=? WHERE id=?',
      )
      .run(
        data.sourceKey,
        data.name,
        data.headerFingerprint,
        JSON.stringify(data.fields),
        new Date().toISOString(),
        id,
      );
    return this.getMapping(id);
  }

  async deleteMapping(id: string): Promise<boolean> {
    return (
      this.sqlite.prepare('DELETE FROM recruitment_import_mappings WHERE id=?').run(id).changes > 0
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
    this.sqlite
      .prepare(
        `INSERT INTO recruitment_import_jobs(
           id,source_key,search_profile_id,mapping_id,mapping_revision,filename,sha256,status,total_rows,started_at
         ) VALUES (?,?,?,?,?,?,?,'running',?,?)`,
      )
      .run(
        id,
        input.sourceKey,
        input.searchProfileId,
        input.mappingId,
        input.mappingRevision,
        input.filename,
        input.sha256,
        input.totalRows,
        new Date().toISOString(),
      );
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
    this.sqlite
      .prepare(
        `UPDATE recruitment_import_jobs SET
           status=?,total_rows=?,imported_rows=?,created_rows=?,updated_rows=?,unchanged_rows=?,error_rows=?,
           error_artifact_id=?,error_summary=?,completed_at=? WHERE id=?`,
      )
      .run(
        input.status,
        input.importedRows + input.errorRows,
        input.importedRows,
        input.createdRows,
        input.updatedRows,
        input.unchangedRows,
        input.errorRows,
        input.errorArtifactId,
        JSON.stringify(input.errorSummary),
        new Date().toISOString(),
        id,
      );
    const job = await this.getImportJob(id);
    if (!job) throw new Error('Recruitment import job disappeared');
    return job;
  }

  async getImportJob(id: string): Promise<RecruitmentImportJob | null> {
    const row = this.sqlite.prepare('SELECT * FROM recruitment_import_jobs WHERE id=?').get(id) as
      DataRow | undefined;
    return row ? importJobRow(row) : null;
  }

  async getImportErrors(
    id: string,
  ): Promise<Array<{ row: number; message: string; data?: unknown }>> {
    const result = this.sqlite
      .prepare('SELECT errors FROM recruitment_import_jobs WHERE id=?')
      .get(id) as DataRow | undefined;
    return result
      ? (json(result.errors) as Array<{ row: number; message: string; data?: unknown }>)
      : [];
  }

  async saveImportErrors(
    id: string,
    errors: Array<{ row: number; message: string; data?: unknown }>,
  ): Promise<void> {
    const summaries = errors.slice(0, 100).map(({ row, message }) => ({ row, message }));
    this.sqlite
      .prepare('UPDATE recruitment_import_jobs SET errors=? WHERE id=?')
      .run(JSON.stringify(summaries), id);
  }

  async upsertPosting(
    input: NormalizedPostingInput,
    provenance: { importJobId: string; importRow: number },
  ): Promise<PostingUpsertResult> {
    const timestamp = new Date().toISOString();
    return this.sqlite.transaction(() => {
      const existing = this.sqlite
        .prepare('SELECT * FROM recruitment_postings WHERE source_key=? AND stable_key=?')
        .get(input.sourceKey, input.stableKey) as DataRow | undefined;
      if (!existing) {
        const id = randomUUID();
        this.insertPosting(id, input, provenance, timestamp);
        return {
          posting: postingRow(
            this.sqlite.prepare('SELECT * FROM recruitment_postings WHERE id=?').get(id) as DataRow,
          ),
          change: 'created' as const,
        };
      }
      const current = postingRow(existing);
      const reopened = ['closed', 'stale'].includes(current.status) && input.status === 'active';
      const status =
        reopened || (current.status === 'reopened' && input.status === 'active')
          ? 'reopened'
          : input.status;
      const changed = current.contentHash !== input.contentHash || current.status !== status;
      this.updatePosting(current.id, { ...input, status }, provenance, timestamp);
      if (changed) {
        const changedFields = postingChangedFields(current, input, status);
        this.sqlite
          .prepare(
            'INSERT INTO recruitment_posting_changes(id,posting_id,import_job_id,previous_hash,current_hash,changed_fields,created_at) VALUES (?,?,?,?,?,?,?)',
          )
          .run(
            randomUUID(),
            current.id,
            provenance.importJobId,
            current.contentHash,
            input.contentHash,
            JSON.stringify(changedFields),
            timestamp,
          );
      }
      const posting = postingRow(
        this.sqlite
          .prepare('SELECT * FROM recruitment_postings WHERE id=?')
          .get(current.id) as DataRow,
      );
      return {
        posting,
        change: reopened
          ? ('reopened' as const)
          : changed
            ? ('updated' as const)
            : ('unchanged' as const),
      };
    })();
  }

  private insertPosting(
    id: string,
    input: NormalizedPostingInput,
    provenance: { importJobId: string; importRow: number },
    timestamp: string,
  ): void {
    this.sqlite
      .prepare(
        `INSERT INTO recruitment_postings(
           id,source_key,stable_key,external_id,source_url,title,company,location,salary_raw,
           salary_min_monthly,salary_max_monthly,salary_months,description,published_at,expires_at,
           experience,education,employment_type,skills,status,normalized_title,normalized_company,
           normalized_location,content_hash,first_seen_at,last_seen_at,import_job_id,import_row,normalizer_version
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        ...postingValues(input),
        timestamp,
        timestamp,
        provenance.importJobId,
        provenance.importRow,
        input.normalizerVersion,
      );
  }

  private updatePosting(
    id: string,
    input: NormalizedPostingInput,
    provenance: { importJobId: string; importRow: number },
    timestamp: string,
  ): void {
    this.sqlite
      .prepare(
        `UPDATE recruitment_postings SET
           external_id=?,source_url=?,title=?,company=?,location=?,salary_raw=?,salary_min_monthly=?,
           salary_max_monthly=?,salary_months=?,description=?,published_at=?,expires_at=?,experience=?,education=?,
           employment_type=?,skills=?,status=?,normalized_title=?,normalized_company=?,normalized_location=?,
           content_hash=?,last_seen_at=?,import_job_id=?,import_row=?,normalizer_version=? WHERE id=?`,
      )
      .run(
        ...postingUpdateValues(input),
        timestamp,
        provenance.importJobId,
        provenance.importRow,
        input.normalizerVersion,
        id,
      );
  }

  async getPosting(id: string): Promise<RecruitmentPosting | null> {
    const row = this.sqlite.prepare('SELECT * FROM recruitment_postings WHERE id=?').get(id) as
      DataRow | undefined;
    return row ? postingRow(row) : null;
  }

  async completeAuthorizedSnapshot(
    sourceKey: RecruitmentSourceKey,
    profileId: string,
    seenPostingIds: readonly string[],
    timestamp: string,
  ): Promise<void> {
    const seen = new Set(seenPostingIds);
    const snapshotAt = Date.parse(timestamp);
    this.sqlite.transaction(() => {
      for (const postingId of seen) {
        this.sqlite
          .prepare(
            `INSERT INTO recruitment_snapshot_presence(
               source_key,profile_id,posting_id,missing_count,first_missing_at,last_seen_at
             ) VALUES (?,?,?,0,NULL,?) ON CONFLICT(source_key,profile_id,posting_id) DO UPDATE SET
             missing_count=0,first_missing_at=NULL,last_seen_at=excluded.last_seen_at`,
          )
          .run(sourceKey, profileId, postingId, timestamp);
      }
      const presences = this.sqlite
        .prepare(
          'SELECT posting_id FROM recruitment_snapshot_presence WHERE source_key=? AND profile_id=?',
        )
        .all(sourceKey, profileId) as DataRow[];
      for (const row of presences) {
        const postingId = String(row.posting_id);
        if (seen.has(postingId)) continue;
        this.sqlite
          .prepare(
            `UPDATE recruitment_snapshot_presence SET
             missing_count=missing_count+1,first_missing_at=COALESCE(first_missing_at,?)
             WHERE source_key=? AND profile_id=? AND posting_id=?`,
          )
          .run(timestamp, sourceKey, profileId, postingId);
        const all = this.sqlite
          .prepare(
            'SELECT missing_count,first_missing_at FROM recruitment_snapshot_presence WHERE posting_id=?',
          )
          .all(postingId) as DataRow[];
        if (all.some((presence) => Number(presence.missing_count) === 0)) continue;
        const firstMissingAt = Math.min(
          ...all.map((presence) => Date.parse(String(presence.first_missing_at))),
        );
        const closed =
          all.every((presence) => Number(presence.missing_count) >= 3) &&
          snapshotAt - firstMissingAt >= 7 * 86_400_000;
        this.recordLifecycleStatus(postingId, closed ? 'closed' : 'stale', timestamp);
      }
    })();
  }

  private recordLifecycleStatus(
    postingId: string,
    status: 'stale' | 'closed',
    timestamp: string,
  ): void {
    const posting = this.sqlite
      .prepare('SELECT status,content_hash FROM recruitment_postings WHERE id=?')
      .get(postingId) as DataRow | undefined;
    if (!posting || posting.status === status || posting.status === 'closed') return;
    this.sqlite
      .prepare('UPDATE recruitment_postings SET status=? WHERE id=?')
      .run(status, postingId);
    this.sqlite
      .prepare(
        `INSERT INTO recruitment_posting_changes(
           id,posting_id,import_job_id,previous_hash,current_hash,changed_fields,created_at
         ) VALUES (?,?,NULL,?,?,?,?)`,
      )
      .run(
        randomUUID(),
        postingId,
        posting.content_hash,
        posting.content_hash,
        JSON.stringify(['status']),
        timestamp,
      );
  }

  async listCandidateClusters(posting: RecruitmentPosting): Promise<RecruitmentJobCluster[]> {
    const rows = this.sqlite
      .prepare(
        `SELECT DISTINCT c.id FROM recruitment_clusters c
         JOIN recruitment_cluster_members cm ON cm.cluster_id=c.id
         JOIN recruitment_postings p ON p.id=cm.posting_id
         WHERE p.normalized_company=? ORDER BY c.updated_at DESC LIMIT 100`,
      )
      .all(posting.normalizedCompany) as DataRow[];
    const clusters = await Promise.all(rows.map((row) => this.getCluster(String(row.id))));
    return clusters.filter((item): item is RecruitmentJobCluster => Boolean(item));
  }

  async createCluster(posting: RecruitmentPosting): Promise<RecruitmentJobCluster> {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          `INSERT INTO recruitment_clusters(
             id,representative_posting_id,title,company,location,confidence,first_seen_at,last_seen_at,created_at,updated_at
           ) VALUES (?,?,?,?,?,1,?,?,?,?)`,
        )
        .run(
          id,
          posting.id,
          posting.title,
          posting.company,
          posting.location,
          posting.firstSeenAt,
          posting.lastSeenAt,
          timestamp,
          timestamp,
        );
      this.sqlite
        .prepare(
          "INSERT INTO recruitment_cluster_members(cluster_id,posting_id,confidence,assignment_source,locked,created_at) VALUES (?,?,1,'automatic',0,?)",
        )
        .run(id, posting.id, timestamp);
      this.sqlite
        .prepare(
          "INSERT INTO recruitment_user_states(cluster_id,state,note,created_at,updated_at) VALUES (?,'untracked','',?,?)",
        )
        .run(id, timestamp, timestamp);
    })();
    return (await this.getCluster(id))!;
  }

  async addPostingToCluster(
    clusterId: string,
    posting: RecruitmentPosting,
    confidence: number,
    assignmentSource: 'automatic' | 'manual' = 'automatic',
    locked = false,
  ): Promise<void> {
    this.sqlite.transaction(() => {
      const current = this.sqlite
        .prepare('SELECT cluster_id,locked FROM recruitment_cluster_members WHERE posting_id=?')
        .get(posting.id) as DataRow | undefined;
      if (current && (Boolean(current.locked) || String(current.cluster_id) === clusterId)) return;
      if (current)
        this.sqlite
          .prepare('DELETE FROM recruitment_cluster_members WHERE posting_id=?')
          .run(posting.id);
      this.sqlite
        .prepare(
          'INSERT INTO recruitment_cluster_members(cluster_id,posting_id,confidence,assignment_source,locked,created_at) VALUES (?,?,?,?,?,?)',
        )
        .run(
          clusterId,
          posting.id,
          confidence,
          assignmentSource,
          locked ? 1 : 0,
          new Date().toISOString(),
        );
      this.sqlite
        .prepare(
          'UPDATE recruitment_clusters SET confidence=MAX(confidence,?),last_seen_at=MAX(last_seen_at,?),updated_at=? WHERE id=?',
        )
        .run(confidence, posting.lastSeenAt, new Date().toISOString(), clusterId);
    })();
  }

  async addClusterSuggestion(suggestion: RecruitmentClusterSuggestion): Promise<void> {
    this.sqlite
      .prepare(
        `INSERT INTO recruitment_cluster_suggestions(cluster_id,candidate_cluster_id,score,evidence,created_at)
         VALUES (?,?,?,?,?) ON CONFLICT(cluster_id,candidate_cluster_id) DO UPDATE SET score=excluded.score,evidence=excluded.evidence`,
      )
      .run(
        suggestion.clusterId,
        suggestion.candidateClusterId,
        suggestion.score,
        JSON.stringify(suggestion.evidence),
        new Date().toISOString(),
      );
  }

  async getCluster(id: string, profileId?: string): Promise<RecruitmentJobCluster | null> {
    const cluster = this.sqlite.prepare('SELECT * FROM recruitment_clusters WHERE id=?').get(id) as
      DataRow | undefined;
    if (!cluster) return null;
    const postings = (
      this.sqlite
        .prepare(
          `SELECT p.* FROM recruitment_postings p
           JOIN recruitment_cluster_members cm ON cm.posting_id=p.id
           WHERE cm.cluster_id=? ORDER BY cm.confidence DESC,p.last_seen_at DESC`,
        )
        .all(id) as DataRow[]
    ).map(postingRow);
    const state = this.sqlite
      .prepare('SELECT state,note FROM recruitment_user_states WHERE cluster_id=?')
      .get(id) as DataRow | undefined;
    const match = profileId
      ? (this.sqlite
          .prepare(
            `SELECT pp.score,pp.reasons FROM recruitment_posting_profiles pp
             JOIN recruitment_cluster_members cm ON cm.posting_id=pp.posting_id
             WHERE cm.cluster_id=? AND pp.profile_id=? ORDER BY pp.score DESC LIMIT 1`,
          )
          .get(id, profileId) as DataRow | undefined)
      : (this.sqlite
          .prepare(
            `SELECT pp.score,pp.reasons FROM recruitment_posting_profiles pp
             JOIN recruitment_cluster_members cm ON cm.posting_id=pp.posting_id
             WHERE cm.cluster_id=? ORDER BY pp.score DESC LIMIT 1`,
          )
          .get(id) as DataRow | undefined);
    const suggestions = (
      this.sqlite
        .prepare(
          'SELECT * FROM recruitment_cluster_suggestions WHERE cluster_id=? ORDER BY score DESC',
        )
        .all(id) as DataRow[]
    ).map(suggestionRow);
    const changes = (
      this.sqlite
        .prepare(
          `SELECT pc.* FROM recruitment_posting_changes pc
           JOIN recruitment_cluster_members cm ON cm.posting_id=pc.posting_id
           WHERE cm.cluster_id=? ORDER BY pc.created_at DESC LIMIT 100`,
        )
        .all(id) as DataRow[]
    ).map(postingChangeRow);
    return {
      id: String(cluster.id),
      representativePostingId: String(cluster.representative_posting_id),
      title: String(cluster.title),
      company: String(cluster.company),
      location: cluster.location === null ? null : String(cluster.location),
      confidence: Number(cluster.confidence),
      firstSeenAt: new Date(String(cluster.first_seen_at)).toISOString(),
      lastSeenAt: new Date(String(cluster.last_seen_at)).toISOString(),
      postings,
      workflowState: (state?.state ?? 'untracked') as RecruitmentWorkflowState,
      note: String(state?.note ?? ''),
      matchScore: match ? Number(match.score) : null,
      matchReasons: match ? (json(match.reasons) as string[]) : [],
      suggestions,
      changes,
    };
  }

  async listClusters(query: RecruitmentClusterQuery): Promise<RecruitmentClusterPage> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const cursor = query.cursor ? decodeClusterCursor(query.cursor) : null;
    const cutoff = new Date(Date.now() - 180 * 86_400_000).toISOString();
    const rows = this.sqlite
      .prepare(
        `SELECT DISTINCT c.id,c.updated_at FROM recruitment_clusters c
         LEFT JOIN recruitment_user_states us ON us.cluster_id=c.id
         WHERE (@profileId IS NULL OR EXISTS (
           SELECT 1 FROM recruitment_cluster_members cm
           JOIN recruitment_posting_profiles pp ON pp.posting_id=cm.posting_id
           WHERE cm.cluster_id=c.id AND pp.profile_id=@profileId
         ))
         AND (@sourceKey IS NULL OR EXISTS (
           SELECT 1 FROM recruitment_cluster_members cm JOIN recruitment_postings p ON p.id=cm.posting_id
           WHERE cm.cluster_id=c.id AND p.source_key=@sourceKey
         ))
         AND (@workflowState IS NULL OR COALESCE(us.state,'untracked')=@workflowState)
         AND (@city IS NULL OR EXISTS (
           SELECT 1 FROM recruitment_cluster_members cm JOIN recruitment_postings p ON p.id=cm.posting_id
           WHERE cm.cluster_id=c.id AND p.normalized_location LIKE @cityPattern
         ))
         AND (@keyword IS NULL OR c.title LIKE @keywordPattern OR c.company LIKE @keywordPattern OR EXISTS (
           SELECT 1 FROM recruitment_cluster_members cm JOIN recruitment_postings p ON p.id=cm.posting_id
           WHERE cm.cluster_id=c.id AND p.description LIKE @keywordPattern
         ))
         AND (@salaryMin IS NULL OR EXISTS (
           SELECT 1 FROM recruitment_cluster_members cm JOIN recruitment_postings p ON p.id=cm.posting_id
           WHERE cm.cluster_id=c.id AND p.salary_max_monthly>=@salaryMin
         ))
         AND (@salaryMax IS NULL OR EXISTS (
           SELECT 1 FROM recruitment_cluster_members cm JOIN recruitment_postings p ON p.id=cm.posting_id
           WHERE cm.cluster_id=c.id AND p.salary_min_monthly<=@salaryMax
         ))
         AND (@publishedAfter IS NULL OR EXISTS (
           SELECT 1 FROM recruitment_cluster_members cm JOIN recruitment_postings p ON p.id=cm.posting_id
           WHERE cm.cluster_id=c.id AND p.published_at>=@publishedAfter
         ))
         AND (@publishedBefore IS NULL OR EXISTS (
           SELECT 1 FROM recruitment_cluster_members cm JOIN recruitment_postings p ON p.id=cm.posting_id
           WHERE cm.cluster_id=c.id AND p.published_at<=@publishedBefore
         ))
         AND (@includeArchived=1 OR EXISTS (
           SELECT 1 FROM recruitment_cluster_members cm JOIN recruitment_postings p ON p.id=cm.posting_id
           WHERE cm.cluster_id=c.id AND (p.status<>'closed' OR p.last_seen_at>=@cutoff)
         ))
         AND (@cursorAt IS NULL OR c.updated_at<@cursorAt OR (c.updated_at=@cursorAt AND c.id<@cursorId))
         ORDER BY c.updated_at DESC,c.id DESC LIMIT @limit`,
      )
      .all({
        profileId: query.profileId ?? null,
        sourceKey: query.sourceKey ?? null,
        workflowState: query.workflowState ?? null,
        city: query.city ?? null,
        cityPattern: `%${query.city ?? ''}%`,
        keyword: query.keyword ?? null,
        keywordPattern: `%${query.keyword ?? ''}%`,
        salaryMin: query.salaryMin ?? null,
        salaryMax: query.salaryMax ?? null,
        publishedAfter: query.publishedAfter ?? null,
        publishedBefore: query.publishedBefore ?? null,
        includeArchived: query.includeArchived ? 1 : 0,
        cutoff,
        cursorAt: cursor?.updatedAt ?? null,
        cursorId: cursor?.id ?? null,
        limit: limit + 1,
      }) as DataRow[];
    const selected = rows.slice(0, limit);
    const items = (
      await Promise.all(selected.map((row) => this.getCluster(String(row.id), query.profileId)))
    ).filter((item): item is RecruitmentJobCluster => Boolean(item));
    const last = selected.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? encodeClusterCursor(String(last.updated_at), String(last.id))
          : null,
    };
  }

  async upsertPostingProfile(input: {
    postingId: string;
    profileId: string;
    score: number;
    reasons: string[];
  }): Promise<void> {
    const timestamp = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT INTO recruitment_posting_profiles(posting_id,profile_id,score,reasons,matched_at,updated_at)
         VALUES (?,?,?,?,?,?) ON CONFLICT(posting_id,profile_id) DO UPDATE SET
         score=excluded.score,reasons=excluded.reasons,updated_at=excluded.updated_at`,
      )
      .run(
        input.postingId,
        input.profileId,
        input.score,
        JSON.stringify(input.reasons),
        timestamp,
        timestamp,
      );
  }

  async deletePostingProfile(postingId: string, profileId: string): Promise<void> {
    this.sqlite
      .prepare('DELETE FROM recruitment_posting_profiles WHERE posting_id=? AND profile_id=?')
      .run(postingId, profileId);
  }

  async setWorkflowState(
    clusterId: string,
    state: RecruitmentWorkflowState,
    note: string,
  ): Promise<RecruitmentJobCluster | null> {
    const timestamp = new Date().toISOString();
    const result = this.sqlite
      .prepare(
        `UPDATE recruitment_user_states SET state=?,note=?,
         applied_at=CASE WHEN ?='applied' THEN COALESCE(applied_at,?) ELSE applied_at END,
         interviewing_at=CASE WHEN ?='interviewing' THEN COALESCE(interviewing_at,?) ELSE interviewing_at END,
         updated_at=? WHERE cluster_id=?`,
      )
      .run(state, note, state, timestamp, state, timestamp, timestamp, clusterId);
    return result.changes > 0 ? this.getCluster(clusterId) : null;
  }

  async mergeClusters(
    targetClusterId: string,
    sourceClusterIds: readonly string[],
  ): Promise<RecruitmentJobCluster | null> {
    const target = await this.getCluster(targetClusterId);
    if (!target) return null;
    this.sqlite.transaction(() => {
      for (const sourceId of [...new Set(sourceClusterIds)].filter(
        (id) => id !== targetClusterId,
      )) {
        const exists = this.sqlite
          .prepare('SELECT id FROM recruitment_clusters WHERE id=?')
          .get(sourceId);
        if (!exists) continue;
        this.sqlite
          .prepare(
            "UPDATE recruitment_cluster_members SET cluster_id=?,assignment_source='manual',locked=1 WHERE cluster_id=?",
          )
          .run(targetClusterId, sourceId);
        this.sqlite.prepare('DELETE FROM recruitment_clusters WHERE id=?').run(sourceId);
      }
      this.sqlite
        .prepare(
          "UPDATE recruitment_cluster_members SET assignment_source='manual',locked=1 WHERE cluster_id=?",
        )
        .run(targetClusterId);
      this.sqlite
        .prepare('UPDATE recruitment_clusters SET confidence=1,updated_at=? WHERE id=?')
        .run(new Date().toISOString(), targetClusterId);
    })();
    return this.getCluster(targetClusterId);
  }

  async splitCluster(
    clusterId: string,
    postingIds: readonly string[],
  ): Promise<RecruitmentJobCluster | null> {
    const ids = [...new Set(postingIds)];
    if (ids.length === 0) return null;
    const rows = this.sqlite
      .prepare(
        `SELECT p.* FROM recruitment_postings p JOIN recruitment_cluster_members cm ON cm.posting_id=p.id
         WHERE cm.cluster_id=?`,
      )
      .all(clusterId) as DataRow[];
    const selected = rows.map(postingRow).filter((posting) => ids.includes(posting.id));
    if (selected.length === 0 || selected.length === rows.length) return null;
    const representative = selected[0]!;
    const newId = randomUUID();
    const timestamp = new Date().toISOString();
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          `INSERT INTO recruitment_clusters(
             id,representative_posting_id,title,company,location,confidence,first_seen_at,last_seen_at,created_at,updated_at
           ) VALUES (?,?,?,?,?,1,?,?,?,?)`,
        )
        .run(
          newId,
          representative.id,
          representative.title,
          representative.company,
          representative.location,
          representative.firstSeenAt,
          representative.lastSeenAt,
          timestamp,
          timestamp,
        );
      for (const posting of selected) {
        this.sqlite
          .prepare(
            "UPDATE recruitment_cluster_members SET cluster_id=?,confidence=1,assignment_source='manual',locked=1 WHERE posting_id=?",
          )
          .run(newId, posting.id);
      }
      this.sqlite
        .prepare(
          "INSERT INTO recruitment_user_states(cluster_id,state,note,created_at,updated_at) VALUES (?,'untracked','',?,?)",
        )
        .run(newId, timestamp, timestamp);
      this.sqlite
        .prepare(
          "UPDATE recruitment_cluster_members SET assignment_source='manual',locked=1 WHERE cluster_id=?",
        )
        .run(clusterId);
      this.sqlite
        .prepare('UPDATE recruitment_clusters SET updated_at=? WHERE id=?')
        .run(timestamp, clusterId);
    })();
    return this.getCluster(newId);
  }

  async createMatchEvent(
    input: Omit<RecruitmentMatchEventRecord, 'id' | 'createdAt' | 'notifiedAt' | 'digestedAt'>,
  ): Promise<RecruitmentMatchEventRecord | null> {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const result = this.sqlite
      .prepare(
        `INSERT OR IGNORE INTO recruitment_match_events(
           id,profile_id,cluster_id,posting_id,event_type,content_hash,score,reasons,created_at
         ) VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        input.profileId,
        input.clusterId,
        input.postingId,
        input.eventType,
        input.contentHash,
        input.score,
        JSON.stringify(input.reasons),
        timestamp,
      );
    if (result.changes === 0) return null;
    return matchEventRow(
      this.sqlite.prepare('SELECT * FROM recruitment_match_events WHERE id=?').get(id) as DataRow,
    );
  }

  async markMatchEventNotified(id: string, timestamp: string): Promise<void> {
    this.sqlite
      .prepare('UPDATE recruitment_match_events SET notified_at=COALESCE(notified_at,?) WHERE id=?')
      .run(timestamp, id);
  }

  async listUndigestedEvents(profileId: string): Promise<RecruitmentMatchEventRecord[]> {
    return (
      this.sqlite
        .prepare(
          'SELECT * FROM recruitment_match_events WHERE profile_id=? AND digested_at IS NULL ORDER BY created_at,id',
        )
        .all(profileId) as DataRow[]
    ).map(matchEventRow);
  }

  async markEventsDigested(profileId: string, timestamp: string): Promise<number> {
    return this.sqlite
      .prepare(
        'UPDATE recruitment_match_events SET digested_at=? WHERE profile_id=? AND digested_at IS NULL',
      )
      .run(timestamp, profileId).changes;
  }
}

function postingValues(input: NormalizedPostingInput): unknown[] {
  return [
    input.sourceKey,
    input.stableKey,
    input.externalId,
    input.sourceUrl,
    input.title,
    input.company,
    input.location,
    input.salaryRaw,
    input.salaryMinMonthly,
    input.salaryMaxMonthly,
    input.salaryMonths,
    input.description,
    input.publishedAt,
    input.expiresAt,
    input.experience,
    input.education,
    input.employmentType,
    JSON.stringify(input.skills),
    input.status,
    input.normalizedTitle,
    input.normalizedCompany,
    input.normalizedLocation,
    input.contentHash,
  ];
}

function postingUpdateValues(input: NormalizedPostingInput): unknown[] {
  return [
    input.externalId,
    input.sourceUrl,
    input.title,
    input.company,
    input.location,
    input.salaryRaw,
    input.salaryMinMonthly,
    input.salaryMaxMonthly,
    input.salaryMonths,
    input.description,
    input.publishedAt,
    input.expiresAt,
    input.experience,
    input.education,
    input.employmentType,
    JSON.stringify(input.skills),
    input.status,
    input.normalizedTitle,
    input.normalizedCompany,
    input.normalizedLocation,
    input.contentHash,
  ];
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
