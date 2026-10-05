import type { CollectionPreviewRecord } from './collection-preview.js';
import type { DiagnosticErrorCode } from './run-diagnostics.js';

export interface CrawlBatch {
  /** Stable hash of the requested URL and extraction stage, independent of retries. */
  requestId: string;
  sequence: number;
  records: Array<{ sourceUrl: string; data: Record<string, unknown> }>;
}

export interface CrawlBatchCommit {
  acceptedCount: number;
  totalCount: number;
}

/** The durable consumer applies the plan's deduplication before acknowledging a batch. */
export type CrawlBatchObserver = (batch: CrawlBatch) => Promise<CrawlBatchCommit>;

/** A disk spool keeps list navigation ahead of detail requests without retaining all rows. */
export interface CrawlListSpool {
  append(batch: CrawlBatch): Promise<void>;
  batches(): AsyncIterable<CrawlBatch>;
}

export interface CrawlDetailData {
  data: Record<string, unknown>;
  inspection?: CollectionPreviewRecord['inspection'];
  recordMatches: number;
  browserUsed: boolean;
  failureCode?: DiagnosticErrorCode;
}

export interface CrawlDetailCache {
  get(key: string): Promise<CrawlDetailData | null>;
  put(key: string, value: CrawlDetailData): Promise<void>;
}

export type CrawlRequestStage = 'api' | 'http' | 'browser' | 'detail';

export interface CrawlRequestSeed {
  id: string;
  url: string;
  stage: CrawlRequestStage;
  kind: 'list' | 'pagination' | 'detail' | 'api';
}

export interface CrawlRequestCheckpoint extends CrawlRequestSeed {
  ordinal: number;
  status: 'pending' | 'completed';
  reservedRecords: number | null;
  sourceUrl: string | null;
  browserUsed: boolean;
  nextRequests: CrawlRequestSeed[];
}

/** Durable URL state is authoritative; the crawler scheduler never stores credentials. */
export interface CrawlCheckpoint {
  queueScope: string;
  storageDirectory: string;
  requests(stage?: CrawlRequestStage, afterOrdinal?: number): Promise<CrawlRequestCheckpoint[]>;
  ensure(seed: CrawlRequestSeed, maxRequests: number): Promise<CrawlRequestCheckpoint | null>;
  reserveRecords(requestId: string, available: number, maxRecords: number): Promise<number>;
  complete(
    requestId: string,
    result: {
      sourceUrl: string;
      browserUsed: boolean;
      nextRequests: CrawlRequestSeed[];
      discoveryBatchCount?: number;
    },
    maxRequests: number,
  ): Promise<CrawlRequestCheckpoint>;
  summary(): Promise<{ requestCount: number; rawRecordCount: number; browserUsed: boolean }>;
}

// A selected row can occupy a batch on its own. Leave enough sequence slots
// for the largest allowed record limit, independent of page byte boundaries.
export const BROWSER_ROUND_BATCH_STRIDE = 10_000_001;

export interface CrawlBrowserRoundState {
  terminal: boolean;
  height: number;
  domHash: string;
  stableRounds: number;
  batchCount: number;
}

export interface CrawlBrowserRound {
  status: 'pending' | 'completed';
  reservedRecords: number;
  availableRecords: number;
  state: CrawlBrowserRoundState | null;
}

/** Replaying actions rebuilds the page; confirmed rounds only verify their data. */
export interface CrawlBrowserPagination {
  begin(input: {
    requestId: string;
    round: number;
    sourceUrl: string;
    checksum: string;
    recordHashes: string[];
    maxRecords: number;
  }): Promise<CrawlBrowserRound>;
  selected(requestId: string, round: number, afterPosition?: number): Promise<number[]>;
  complete(requestId: string, round: number, state: CrawlBrowserRoundState): Promise<void>;
}

export interface CrawlSitemapNode {
  id: string;
  url: string;
  depth: number;
  ordinal: number;
}

export interface CrawlSitemapEntry {
  url: string;
  lastModified: string | null;
}

export interface CrawlSitemapBatch {
  requestId: string;
  sequence: number;
  entries: CrawlSitemapEntry[];
  nodes: Array<Omit<CrawlSitemapNode, 'ordinal'>>;
}

export interface CrawlSitemapState {
  nodeCount: number;
  entryCount: number;
  sitemapsTruncated: boolean;
}

/** Discovery is persisted before URL completion; sorted output is read in bounded pages. */
export interface CrawlSitemapSpool {
  root(node: Omit<CrawlSitemapNode, 'ordinal'>, maxSitemaps: number): Promise<void>;
  nodes(afterOrdinal?: number): Promise<CrawlSitemapNode[]>;
  append(batch: CrawlSitemapBatch, maxSitemaps: number, maxUrls: number): Promise<void>;
  summary(): Promise<CrawlSitemapState>;
  batches(input: {
    requestId: string;
    urlField: string;
    lastModifiedField?: string;
    limit: number;
  }): AsyncIterable<CrawlBatch>;
}
