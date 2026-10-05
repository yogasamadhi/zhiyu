import type { AnalysisResult, BrowserSemanticGoal } from './index.js';

/** Cache persistence receives opaque digests and verified payloads only. */
export interface ValidatedCacheKey {
  kind: 'rule' | 'action';
  scopeHash: string;
  sessionHash: string;
  ruleHash: string;
  configurationHash: string;
  providerHash: string;
  promptHash: string;
  actionHash: string;
  structureHash: string;
  keyHash: string;
}
export interface ValidatedCacheEntry extends ValidatedCacheKey {
  /** Parent task/draft digest for clearing all independently cached page stages. */
  ownerScopeHash?: string;
  payload: string;
  payloadHash: string;
  createdAt: number;
  expiresAt: number;
  hitCount: number;
}
export interface ValidatedCacheRepository {
  readValidatedCache(
    scopeHash: string,
    kind: ValidatedCacheKey['kind'],
  ): Promise<{ generation: number; entry: ValidatedCacheEntry | null }>;
  writeValidatedCache(entry: ValidatedCacheEntry, expectedGeneration: number): Promise<boolean>;
  hitValidatedCache(
    keyHash: string,
    payloadHash: string,
    expectedGeneration: number,
  ): Promise<boolean>;
  deleteValidatedCache(keyHash: string): Promise<void>;
  clearValidatedCache(scopeHash: string): Promise<number>;
}

export interface BrowserActionCandidate {
  selector: string;
  tag: string;
  role: string | null;
}
export interface BrowserActionRepairInput {
  actionType: 'click' | 'press' | 'hover';
  semanticGoal: BrowserSemanticGoal;
  candidates: BrowserActionCandidate[];
}
export interface CacheProviderIdentity {
  provider: string;
  model: string;
  configuration: string;
  promptVersion?: string;
  toolSchemaVersion?: string;
}
/** Internal composition input; repositories and provider credentials never enter task JSON. */
export interface BrowserActionCacheBinding {
  scope: string;
  ruleVersion?: string;
  taskVersion?: number;
  configuration?: unknown;
}
export interface BrowserActionCacheContext {
  repository: ValidatedCacheRepository;
  scope: string;
  ruleVersion?: string;
  taskVersion?: number;
  configuration?: unknown;
  identity?: () => CacheProviderIdentity | undefined;
  /** Explicit repair authorization; absent by default. Fill/select/wait are never sent here. */
  repair?: (input: BrowserActionRepairInput, signal?: AbortSignal) => Promise<{ selector: string }>;
  maxRepairCalls?: number;
  onResult?: (result: NonNullable<AnalysisResult['cache']>) => void | Promise<void>;
}
