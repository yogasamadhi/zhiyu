import {
  recruitmentImportJobSchema,
  recruitmentImportMappingSchema,
  recruitmentPostingSchema,
  recruitmentSearchProfileSchema,
  recruitmentSourceSchema,
  type RecruitmentClusterSuggestion,
  type RecruitmentImportJob,
  type RecruitmentImportMapping,
  type RecruitmentPosting,
  type RecruitmentPostingChange,
  type RecruitmentSearchProfile,
  type RecruitmentSource,
} from '@zhiyun/shared';
import type { RecruitmentMatchEventRecord } from '../contracts/index.js';

export type DataRow = Record<string, unknown>;

export function sourceRow(row: DataRow): RecruitmentSource {
  return recruitmentSourceSchema.parse({
    key: row.key,
    name: row.name,
    officialHost: row.official_host,
    allowedHosts: json(row.allowed_hosts),
    termsUrl: row.terms_url,
    robotsUrl: row.robots_url,
    checkedAt: iso(row.checked_at),
    mode: row.mode,
    authorizationStatus: row.authorization_status,
    liveSyncAvailable: booleanValue(row.live_sync_available),
    adapterVersion: nullableString(row.adapter_version),
    authorizationScope: nullableString(row.authorization_scope),
    credentialRef: nullableString(row.credential_ref),
    lastSyncAt: nullableIso(row.last_sync_at),
    lastImportAt: nullableIso(row.last_import_at),
    lastError: nullableString(row.last_error),
  });
}

export function profileRow(row: DataRow): RecruitmentSearchProfile {
  return recruitmentSearchProfileSchema.parse({
    ...(json(row.data) as Record<string, unknown>),
    id: row.id,
    revision: numberValue(row.revision),
    lastDigestAt: nullableIso(row.last_digest_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

export function mappingRow(row: DataRow): RecruitmentImportMapping {
  return recruitmentImportMappingSchema.parse({
    id: row.id,
    sourceKey: row.source_key,
    name: row.name,
    headerFingerprint: row.header_fingerprint,
    fields: json(row.fields),
    revision: numberValue(row.revision),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

export function importJobRow(row: DataRow): RecruitmentImportJob {
  return recruitmentImportJobSchema.parse({
    id: row.id,
    sourceKey: row.source_key,
    searchProfileId: row.search_profile_id,
    mappingId: nullableString(row.mapping_id),
    mappingRevision:
      row.mapping_revision === null || row.mapping_revision === undefined
        ? null
        : numberValue(row.mapping_revision),
    filename: row.filename,
    sha256: row.sha256,
    status: row.status,
    totalRows: numberValue(row.total_rows),
    importedRows: numberValue(row.imported_rows),
    createdRows: numberValue(row.created_rows),
    updatedRows: numberValue(row.updated_rows),
    unchangedRows: numberValue(row.unchanged_rows),
    errorRows: numberValue(row.error_rows),
    errorArtifactId: nullableString(row.error_artifact_id),
    errorSummary: json(row.error_summary),
    startedAt: iso(row.started_at),
    completedAt: nullableIso(row.completed_at),
  });
}

export function postingRow(row: DataRow): RecruitmentPosting {
  return recruitmentPostingSchema.parse({
    id: row.id,
    sourceKey: row.source_key,
    stableKey: row.stable_key,
    externalId: nullableString(row.external_id),
    sourceUrl: nullableString(row.source_url),
    title: row.title,
    company: row.company,
    location: nullableString(row.location),
    salaryRaw: nullableString(row.salary_raw),
    salaryMinMonthly: nullableNumber(row.salary_min_monthly),
    salaryMaxMonthly: nullableNumber(row.salary_max_monthly),
    salaryMonths: nullableNumber(row.salary_months),
    description: nullableString(row.description),
    publishedAt: nullableIso(row.published_at),
    expiresAt: nullableIso(row.expires_at),
    experience: nullableString(row.experience),
    education: nullableString(row.education),
    employmentType: nullableString(row.employment_type),
    skills: json(row.skills),
    status: row.status,
    normalizedTitle: row.normalized_title,
    normalizedCompany: row.normalized_company,
    normalizedLocation: row.normalized_location,
    contentHash: row.content_hash,
    firstSeenAt: iso(row.first_seen_at),
    lastSeenAt: iso(row.last_seen_at),
    importJobId: nullableString(row.import_job_id),
    importRow: nullableNumber(row.import_row),
    normalizerVersion: row.normalizer_version,
  });
}

export function suggestionRow(row: DataRow): RecruitmentClusterSuggestion {
  return {
    clusterId: String(row.cluster_id),
    candidateClusterId: String(row.candidate_cluster_id),
    score: Number(row.score),
    evidence: json(row.evidence) as Record<string, unknown>,
  };
}

export function postingChangeRow(row: DataRow): RecruitmentPostingChange {
  return {
    id: String(row.id),
    postingId: String(row.posting_id),
    previousHash: String(row.previous_hash),
    currentHash: String(row.current_hash),
    changedFields: json(row.changed_fields) as string[],
    createdAt: iso(row.created_at),
  };
}

export function matchEventRow(row: DataRow): RecruitmentMatchEventRecord {
  return {
    id: String(row.id),
    profileId: String(row.profile_id),
    clusterId: String(row.cluster_id),
    postingId: String(row.posting_id),
    eventType: row.event_type as RecruitmentMatchEventRecord['eventType'],
    contentHash: String(row.content_hash),
    score: Number(row.score),
    reasons: json(row.reasons) as string[],
    createdAt: iso(row.created_at),
    notifiedAt: nullableIso(row.notified_at),
    digestedAt: nullableIso(row.digested_at),
  };
}

export function json(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

export function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function numberValue(value: unknown): number {
  return Number(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

export function encodeClusterCursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ updatedAt, id })).toString('base64url');
}

export function decodeClusterCursor(cursor: string): { updatedAt: string; id: string } {
  const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as Record<string, unknown>;
  if (typeof parsed.updatedAt !== 'string' || typeof parsed.id !== 'string')
    throw new Error('Invalid recruitment cursor');
  return { updatedAt: parsed.updatedAt, id: parsed.id };
}
