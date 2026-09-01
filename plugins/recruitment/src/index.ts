import { createServiceToken, type PluginDescriptor } from '@zhiyun/kernel';
import type { RecruitmentRepository } from './contracts/index.js';
import { recruitmentRoutes } from './http/index.js';
import { recruitmentUiContributions } from './ui/index.js';

export const recruitmentService = createServiceToken<RecruitmentRepository>(
  'recruitment.service',
  '1.0.0',
  'recruitment',
);

export const recruitmentPlugin: PluginDescriptor = {
  id: 'recruitment',
  version: '1.0.0',
  dependencies: [
    { id: 'collection', range: '^1.0.0' },
    { id: 'datasets', range: '^1.0.0' },
    { id: 'outputs', range: '^1.0.0' },
  ],
  providedServices: [recruitmentService],
  optionalCapabilities: ['host.notifications', 'host.credentials'],
  routes: recruitmentRoutes,
  events: [
    { type: 'recruitment.match.detected', durable: true },
    { type: 'recruitment.posting.changed', durable: true },
    { type: 'recruitment.digest.ready', durable: true },
  ],
  migrations: [
    {
      id: '001-initial',
      tables: [
        'recruitment_sources',
        'recruitment_search_profiles',
        'recruitment_source_bindings',
        'recruitment_import_mappings',
        'recruitment_import_jobs',
        'recruitment_postings',
        'recruitment_snapshot_presence',
        'recruitment_posting_changes',
        'recruitment_clusters',
        'recruitment_cluster_members',
        'recruitment_cluster_suggestions',
        'recruitment_posting_profiles',
        'recruitment_user_states',
        'recruitment_match_events',
      ],
    },
  ],
  uiContributions: recruitmentUiContributions,
  activate() {},
};

export * from './application/index.js';
export * from './contracts/index.js';
export * from './domain/index.js';
export * from './http/index.js';
export * from './migrations/postgres/index.js';
export * from './migrations/sqlite/index.js';
export * from './persistence/postgres/index.js';
export * from './persistence/sqlite/index.js';
export * from './ui/index.js';
