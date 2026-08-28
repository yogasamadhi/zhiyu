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
  optionalCapabilities: ['storage.sqlite', 'storage.postgres', 'queue.local', 'queue.redis'],
  providedServices: [platformRepositoryService, artifactStoreService],
  routes: [
    { operationId: 'getHealth', method: 'GET', path: '/health' },
    { operationId: 'createSession', method: 'POST', path: '/api/v2/session' },
    { operationId: 'getVersion', method: 'GET', path: '/api/v2/version' },
    { operationId: 'getRuntime', method: 'GET', path: '/api/v2/runtime' },
    { operationId: 'getRuntimeGraph', method: 'GET', path: '/api/v2/runtime/graph' },
    { operationId: 'getCapabilities', method: 'GET', path: '/api/v2/capabilities' },
    { operationId: 'getProductOpenApi', method: 'GET', path: '/api/v2/openapi.json' },
    { operationId: 'streamDomainEvents', method: 'GET', path: '/api/v2/events/domain' },
    { operationId: 'streamRealtimeEvents', method: 'GET', path: '/api/v2/events/realtime' },
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
  ],
  activate() {},
};
