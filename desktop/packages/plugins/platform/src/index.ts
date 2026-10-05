import { createServiceToken, type PluginDescriptor } from '@zhiyun/kernel';
import type { ArtifactStore, PlatformRepository } from '@zhiyun/platform-core';

export const platformRepositoryService = createServiceToken<PlatformRepository>(
  'platform.repository',
  '1.0.0',
  'platform',
);

export const artifactStoreService = createServiceToken<ArtifactStore>(
  'artifact.store',
  '1.0.0',
  'platform',
);

export const platformPlugin: PluginDescriptor = {
  id: 'platform',
  version: '1.0.0',
  optionalCapabilities: ['storage.sqlite', 'queue.local'],
  providedServices: [platformRepositoryService, artifactStoreService],
  routes: [
    {
      operationId: 'getWorkspaceIdentity',
      method: 'GET',
      path: '/api/v2/workspace',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'writeExperienceEvent',
      method: 'POST',
      path: '/api/v2/experience/events',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'getExperienceSummary',
      method: 'GET',
      path: '/api/v2/experience/summary',
      requiredPermission: 'workspace.manage',
    },
    {
      operationId: 'getExperienceSettings',
      method: 'GET',
      path: '/api/v2/experience/settings',
      requiredPermission: 'workspace.manage',
    },
    {
      operationId: 'updateExperienceSettings',
      method: 'PUT',
      path: '/api/v2/experience/settings',
      requiredPermission: 'workspace.manage',
    },
    {
      operationId: 'clearExperienceEvents',
      method: 'DELETE',
      path: '/api/v2/experience/events',
      requiredPermission: 'workspace.manage',
    },
    { operationId: 'getHealth', method: 'GET', path: '/health', requiredPermission: null },
    { operationId: 'getReadiness', method: 'GET', path: '/ready', requiredPermission: null },
    {
      operationId: 'createSession',
      method: 'POST',
      path: '/api/v2/session',
      requiredPermission: null,
    },
    {
      operationId: 'getVersion',
      method: 'GET',
      path: '/api/v2/version',
      requiredPermission: null,
    },
    {
      operationId: 'getRuntime',
      method: 'GET',
      path: '/api/v2/runtime',
      requiredPermission: null,
    },
    {
      operationId: 'getRuntimeGraph',
      method: 'GET',
      path: '/api/v2/runtime/graph',
      requiredPermission: null,
    },
    {
      operationId: 'getCapabilities',
      method: 'GET',
      path: '/api/v2/capabilities',
      requiredPermission: null,
    },
    {
      operationId: 'getProductOpenApi',
      method: 'GET',
      path: '/api/v2/openapi.json',
      requiredPermission: null,
    },
    {
      operationId: 'streamDomainEvents',
      method: 'GET',
      path: '/api/v2/events/domain',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'streamRealtimeEvents',
      method: 'GET',
      path: '/api/v2/events/realtime',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'saveArtifactWithHost',
      method: 'POST',
      path: '/api/v2/artifacts/{artifactId}/save',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'getArtifactContent',
      method: 'GET',
      path: '/api/v2/artifacts/{artifactId}/content',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'getRuntimeSummary',
      method: 'GET',
      path: '/api/v2/runtime/summary',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'getDesktopDiagnostics',
      method: 'GET',
      path: '/api/v2/desktop/diagnostics',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'pauseScheduler',
      method: 'POST',
      path: '/api/v2/scheduler/pause',
      requiredPermission: 'workspace.manage',
    },
    {
      operationId: 'resumeScheduler',
      method: 'POST',
      path: '/api/v2/scheduler/resume',
      requiredPermission: 'workspace.manage',
    },
  ],
  events: [
    { type: 'platform.job.created', durable: true },
    { type: 'platform.job.interrupted', durable: true },
    { type: 'platform.job.dead-lettered', durable: true },
  ],
  migrations: [
    {
      id: '001-initial',
      tables: [
        'zhiyun_meta',
        'plugin_migrations',
        'platform_jobs',
        'platform_events',
        'event_consumer_checkpoints',
        'event_dead_letters',
        'platform_artifacts',
        'idempotency_keys',
        'runtime_settings',
      ],
    },
    { id: '002-local-experience', tables: ['experience_events'] },
    { id: '003-assistant-experience', tables: [] },
  ],
  uiContributions: [
    { id: 'platform.settings-route', kind: 'route' },
    { id: 'platform.settings-navigation', kind: 'navigation' },
  ],
  activate() {},
};
