export { analyticsPlugin } from './manifest.js';
export { apply, Config, default, inject } from './plugin.js';
import type { AnalysisMethodDescriptor } from './contracts/index.js';

export interface AnalyticsCatalogService {
  listMethods(): Promise<AnalysisMethodDescriptor[]>;
}

export * from './application/index.js';
export * from './contracts/index.js';
export * from './http/index.js';
export * from './migrations/sqlite/002-result-lineage.js';
export * from './migrations/sqlite/index.js';
export * from './persistence/sqlite/index.js';
