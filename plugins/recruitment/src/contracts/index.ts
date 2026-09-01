import type {
  RecruitmentClusterSuggestion,
  RecruitmentImportJob,
  RecruitmentImportMapping,
  RecruitmentImportMappingInput,
  RecruitmentJobCluster,
  RecruitmentPosting,
  RecruitmentSearchProfile,
  RecruitmentSearchProfileInput,
  RecruitmentSource,
  RecruitmentSourceKey,
  RecruitmentSyncResult,
  RecruitmentWorkflowState,
} from '@zhiyun/shared';
import type { NormalizedPostingInput } from '../domain/index.js';

export interface PostingUpsertResult {
  posting: RecruitmentPosting;
  change: 'created' | 'updated' | 'unchanged' | 'reopened';
}

export interface RecruitmentClusterPage {
  items: RecruitmentJobCluster[];
  nextCursor: string | null;
}

export interface RecruitmentClusterQuery {
  cursor?: string;
  limit?: number;
  profileId?: string;
  sourceKey?: RecruitmentSourceKey;
  workflowState?: RecruitmentWorkflowState;
  city?: string;
  keyword?: string;
  salaryMin?: number;
  salaryMax?: number;
  publishedAfter?: string;
  publishedBefore?: string;
  includeArchived?: boolean;
}

export interface RecruitmentMatchEventRecord {
  id: string;
  profileId: string;
  clusterId: string;
  postingId: string;
  eventType: 'recruitment.match.detected' | 'recruitment.posting.changed';
  contentHash: string;
  score: number;
  reasons: string[];
  createdAt: string;
  notifiedAt: string | null;
  digestedAt: string | null;
}

export interface RecruitmentRepository {
  migrate(): Promise<void>;
  close(): Promise<void>;
  listSources(): Promise<RecruitmentSource[]>;
  getSource(key: RecruitmentSourceKey): Promise<RecruitmentSource | null>;
  installAuthorizedSource(input: ReviewedRecruitmentAdapter): Promise<void>;
  markSourceImported(key: RecruitmentSourceKey, timestamp: string): Promise<void>;
  markSourceSynced(
    key: RecruitmentSourceKey,
    timestamp: string,
    error: string | null,
  ): Promise<void>;
  listProfiles(): Promise<RecruitmentSearchProfile[]>;
  getProfile(id: string): Promise<RecruitmentSearchProfile | null>;
  createProfile(input: RecruitmentSearchProfileInput): Promise<RecruitmentSearchProfile>;
  updateProfile(
    id: string,
    input: RecruitmentSearchProfileInput,
    expectedRevision: number,
  ): Promise<RecruitmentSearchProfile | 'revision-conflict' | null>;
  deleteProfile(id: string): Promise<boolean>;
  markProfileDigested(id: string, timestamp: string): Promise<void>;
  listMappings(sourceKey?: RecruitmentSourceKey): Promise<RecruitmentImportMapping[]>;
  getMapping(id: string): Promise<RecruitmentImportMapping | null>;
  findMapping(
    sourceKey: RecruitmentSourceKey,
    headerFingerprint: string,
  ): Promise<RecruitmentImportMapping | null>;
  createMapping(input: RecruitmentImportMappingInput): Promise<RecruitmentImportMapping>;
  updateMapping(
    id: string,
    input: RecruitmentImportMappingInput,
    expectedRevision: number,
  ): Promise<RecruitmentImportMapping | 'revision-conflict' | null>;
  deleteMapping(id: string): Promise<boolean>;
  createImportJob(input: {
    sourceKey: RecruitmentSourceKey;
    searchProfileId: string;
    mappingId: string | null;
    mappingRevision: number | null;
    filename: string;
    sha256: string;
    totalRows: number;
  }): Promise<RecruitmentImportJob>;
  finishImportJob(
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
  ): Promise<RecruitmentImportJob>;
  getImportJob(id: string): Promise<RecruitmentImportJob | null>;
  getImportErrors(id: string): Promise<Array<{ row: number; message: string; data?: unknown }>>;
  saveImportErrors(
    id: string,
    errors: Array<{ row: number; message: string; data?: unknown }>,
  ): Promise<void>;
  upsertPosting(
    input: NormalizedPostingInput,
    provenance: { importJobId: string; importRow: number },
  ): Promise<PostingUpsertResult>;
  getPosting(id: string): Promise<RecruitmentPosting | null>;
  completeAuthorizedSnapshot(
    sourceKey: RecruitmentSourceKey,
    profileId: string,
    seenPostingIds: readonly string[],
    timestamp: string,
  ): Promise<void>;
  listCandidateClusters(posting: RecruitmentPosting): Promise<RecruitmentJobCluster[]>;
  createCluster(posting: RecruitmentPosting): Promise<RecruitmentJobCluster>;
  addPostingToCluster(
    clusterId: string,
    posting: RecruitmentPosting,
    confidence: number,
    assignmentSource?: 'automatic' | 'manual',
    locked?: boolean,
  ): Promise<void>;
  addClusterSuggestion(suggestion: RecruitmentClusterSuggestion): Promise<void>;
  getCluster(id: string, profileId?: string): Promise<RecruitmentJobCluster | null>;
  listClusters(query: RecruitmentClusterQuery): Promise<RecruitmentClusterPage>;
  upsertPostingProfile(input: {
    postingId: string;
    profileId: string;
    score: number;
    reasons: string[];
  }): Promise<void>;
  deletePostingProfile(postingId: string, profileId: string): Promise<void>;
  setWorkflowState(
    clusterId: string,
    state: RecruitmentWorkflowState,
    note: string,
  ): Promise<RecruitmentJobCluster | null>;
  mergeClusters(
    targetClusterId: string,
    sourceClusterIds: readonly string[],
  ): Promise<RecruitmentJobCluster | null>;
  splitCluster(
    clusterId: string,
    postingIds: readonly string[],
  ): Promise<RecruitmentJobCluster | null>;
  createMatchEvent(
    input: Omit<RecruitmentMatchEventRecord, 'id' | 'createdAt' | 'notifiedAt' | 'digestedAt'>,
  ): Promise<RecruitmentMatchEventRecord | null>;
  markMatchEventNotified(id: string, timestamp: string): Promise<void>;
  listUndigestedEvents(profileId: string): Promise<RecruitmentMatchEventRecord[]>;
  markEventsDigested(profileId: string, timestamp: string): Promise<number>;
}

export interface ReviewedRecruitmentAdapter {
  sourceKey: RecruitmentSourceKey;
  version: string;
  authorizationScope: string;
  credentialRef: string;
}

export type RecruitmentSourceSyncResult = RecruitmentSyncResult;

export interface RecruitmentSourceAdapter {
  readonly sourceKey: RecruitmentSourceKey;
  readonly version: string;
  readonly authorizationScope: string;
  readonly credentialRef: string;
  health(input: { credential: unknown }): Promise<{ ok: boolean; detail?: string }>;
  collect(input: {
    profile: RecruitmentSearchProfile;
    cursor?: string;
    credential: unknown;
  }): Promise<{
    rows: Array<Record<string, unknown>>;
    nextCursor: string | null;
    complete: boolean;
  }>;
  normalize(row: Record<string, unknown>): NormalizedPostingInput;
}
