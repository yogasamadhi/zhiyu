import { createServiceToken, type PluginDescriptor } from '@zhiyun/kernel';
import type { IdentityServiceContract } from './contracts/index.js';
import { identityRoutes } from './http/index.js';

export const identityService = createServiceToken<IdentityServiceContract>(
  'identity.service',
  '1.0.0',
  'identity',
);

export const identityPlugin: PluginDescriptor = {
  id: 'identity',
  version: '1.0.0',
  providedServices: [identityService],
  routes: identityRoutes,
  migrations: [
    {
      id: '001-initial',
      tables: [
        'identity_users',
        'identity_sessions',
        'identity_invitations',
        'identity_password_reset_tokens',
        'identity_login_attempts',
        'identity_audit_events',
      ],
    },
  ],
  uiContributions: [
    { id: 'identity.members-route', kind: 'route' },
    { id: 'identity.members-navigation', kind: 'navigation' },
    { id: 'identity.audit-route', kind: 'route' },
    { id: 'identity.audit-navigation', kind: 'navigation' },
  ],
  activate() {},
};

export * from './application/index.js';
export * from './contracts/index.js';
export * from './domain/index.js';
export * from './http/index.js';

export * from './migrations/sqlite/index.js';
export * from './persistence/sqlite/index.js';
