import type { PluginManifest } from '@zhiyun/plugin-runtime';
export const identityPlugin = {
  id: 'identity',
  version: '1.0.0',
  providedServices: [
    {
      id: 'identity.service',
      version: '1.0.0',
      owner: 'identity',
    },
  ],
  routes: [
    {
      operationId: 'getAuthStatus',
      method: 'GET',
      path: '/api/v2/auth/status',
      requiredPermission: null,
    },
    {
      operationId: 'setupAuth',
      method: 'POST',
      path: '/api/v2/auth/setup',
      requiredPermission: null,
    },
    {
      operationId: 'login',
      method: 'POST',
      path: '/api/v2/auth/login',
      requiredPermission: null,
    },
    {
      operationId: 'logout',
      method: 'POST',
      path: '/api/v2/auth/logout',
      requiredPermission: null,
    },
    {
      operationId: 'getCurrentUser',
      method: 'GET',
      path: '/api/v2/auth/me',
      requiredPermission: 'workspace.read',
    },
    {
      operationId: 'changePassword',
      method: 'POST',
      path: '/api/v2/auth/password',
      requiredPermission: null,
    },
    {
      operationId: 'listMembers',
      method: 'GET',
      path: '/api/v2/members',
      requiredPermission: 'member.manage',
    },
    {
      operationId: 'updateMember',
      method: 'PATCH',
      path: '/api/v2/members/{memberId}',
      requiredPermission: 'member.manage',
    },
    {
      operationId: 'createMemberPasswordReset',
      method: 'POST',
      path: '/api/v2/members/{memberId}/password-reset',
      requiredPermission: 'member.manage',
    },
    {
      operationId: 'listInvitations',
      method: 'GET',
      path: '/api/v2/invitations',
      requiredPermission: 'member.manage',
    },
    {
      operationId: 'createInvitation',
      method: 'POST',
      path: '/api/v2/invitations',
      requiredPermission: 'member.manage',
    },
    {
      operationId: 'deleteInvitation',
      method: 'DELETE',
      path: '/api/v2/invitations/{invitationId}',
      requiredPermission: 'member.manage',
    },
    {
      operationId: 'acceptInvitation',
      method: 'POST',
      path: '/api/v2/invitations/accept',
      requiredPermission: null,
    },
    {
      operationId: 'listAuditEvents',
      method: 'GET',
      path: '/api/v2/audit-events',
      requiredPermission: 'audit.read',
    },
  ],
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
    {
      id: 'identity.members-route',
      kind: 'route',
    },
    {
      id: 'identity.members-navigation',
      kind: 'navigation',
    },
    {
      id: 'identity.audit-route',
      kind: 'route',
    },
    {
      id: 'identity.audit-navigation',
      kind: 'navigation',
    },
  ],
} as const satisfies PluginManifest;
export default identityPlugin;
