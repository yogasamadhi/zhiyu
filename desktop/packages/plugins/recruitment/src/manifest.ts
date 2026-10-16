import type { PluginManifest } from '@zhiyun/plugin-runtime';
export const recruitmentPlugin = {
  id: 'recruitment',
  version: '1.0.0',
  dependencies: [
    {
      id: 'collection',
      range: '^1.0.0',
    },
    {
      id: 'datasets',
      range: '^1.0.0',
    },
    {
      id: 'outputs',
      range: '^1.0.0',
    },
  ],
  providedServices: [
    {
      id: 'recruitment.service',
      version: '1.0.0',
      owner: 'recruitment',
    },
  ],
  optionalCapabilities: ['host.notifications', 'host.credentials'],
  routes: [
    {
      operationId: 'listRecruitmentSources',
      method: 'GET',
      path: '/api/v2/recruitment/sources',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'getRecruitmentSource',
      method: 'GET',
      path: '/api/v2/recruitment/sources/{sourceKey}',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'syncRecruitmentSource',
      method: 'POST',
      path: '/api/v2/recruitment/sources/{sourceKey}/sync',
      requiredPermission: 'run.execute',
    },
    {
      operationId: 'listRecruitmentSearchProfiles',
      method: 'GET',
      path: '/api/v2/recruitment/search-profiles',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'createRecruitmentSearchProfile',
      method: 'POST',
      path: '/api/v2/recruitment/search-profiles',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'getRecruitmentSearchProfile',
      method: 'GET',
      path: '/api/v2/recruitment/search-profiles/{profileId}',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'updateRecruitmentSearchProfile',
      method: 'PATCH',
      path: '/api/v2/recruitment/search-profiles/{profileId}',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'deleteRecruitmentSearchProfile',
      method: 'DELETE',
      path: '/api/v2/recruitment/search-profiles/{profileId}',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'previewRecruitmentImport',
      method: 'POST',
      path: '/api/v2/recruitment/imports/preview',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'createRecruitmentImport',
      method: 'POST',
      path: '/api/v2/recruitment/imports',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'getRecruitmentImport',
      method: 'GET',
      path: '/api/v2/recruitment/imports/{importId}',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'getRecruitmentImportErrors',
      method: 'GET',
      path: '/api/v2/recruitment/imports/{importId}/errors',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'listRecruitmentImportMappings',
      method: 'GET',
      path: '/api/v2/recruitment/import-mappings',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'createRecruitmentImportMapping',
      method: 'POST',
      path: '/api/v2/recruitment/import-mappings',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'updateRecruitmentImportMapping',
      method: 'PATCH',
      path: '/api/v2/recruitment/import-mappings/{mappingId}',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'deleteRecruitmentImportMapping',
      method: 'DELETE',
      path: '/api/v2/recruitment/import-mappings/{mappingId}',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'listRecruitmentJobClusters',
      method: 'GET',
      path: '/api/v2/recruitment/job-clusters',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'getRecruitmentJobCluster',
      method: 'GET',
      path: '/api/v2/recruitment/job-clusters/{clusterId}',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'updateRecruitmentWorkflowState',
      method: 'PUT',
      path: '/api/v2/recruitment/job-clusters/{clusterId}/state',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'mergeRecruitmentJobClusters',
      method: 'POST',
      path: '/api/v2/recruitment/job-clusters/merge',
      requiredPermission: 'task.write',
    },
    {
      operationId: 'splitRecruitmentJobCluster',
      method: 'POST',
      path: '/api/v2/recruitment/job-clusters/{clusterId}/split',
      requiredPermission: 'task.write',
    },
  ],
  events: [
    {
      type: 'recruitment.match.detected',
      durable: true,
    },
    {
      type: 'recruitment.posting.changed',
      durable: true,
    },
    {
      type: 'recruitment.digest.ready',
      durable: true,
    },
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
  uiContributions: [
    {
      id: 'recruitment.route',
      kind: 'route',
    },
    {
      id: 'recruitment.navigation',
      kind: 'navigation',
    },
  ],
} as const satisfies PluginManifest;
export default recruitmentPlugin;
