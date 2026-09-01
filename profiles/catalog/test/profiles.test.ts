import { describe, expect, it } from 'vitest';
import { createArchitectureCatalog } from '@zhiyun/kernel';
import {
  rolePermissions,
  type IdentityPermission,
  type IdentityRole,
} from '@zhiyun/plugin-identity';
import { productProfiles, resolveProductGraph } from '../src/index.js';

describe('product profiles', () => {
  it('resolves every official profile', () => {
    for (const profile of productProfiles) {
      const graph = resolveProductGraph(profile.id);
      expect(graph.profile.id).toBe(profile.id);
      expect(graph.revision).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('assigns one owner to every desktop-studio contribution', () => {
    const catalog = createArchitectureCatalog(resolveProductGraph('desktop-studio'));
    expect(new Set(catalog.tables.map(({ id }) => id)).size).toBe(catalog.tables.length);
    expect(new Set(catalog.routes.map(({ id }) => id)).size).toBe(catalog.routes.length);
    expect(catalog.plugins.map(({ id }) => id)).not.toContain('legacy.runtime');
  });

  it('enables Identity only for the Headless PostgreSQL profile', () => {
    expect(
      resolveProductGraph('headless-server').plugins.map(({ descriptor }) => descriptor.id),
    ).toContain('identity');
    for (const profileId of ['desktop-studio', 'safe', 'test', 'e2e']) {
      expect(
        resolveProductGraph(profileId).plugins.map(({ descriptor }) => descriptor.id),
      ).not.toContain('identity');
    }
  });

  it('enables Recruitment for core-data profiles but excludes the safe profile', () => {
    for (const profileId of ['desktop-studio', 'headless-server', 'test', 'e2e']) {
      expect(
        resolveProductGraph(profileId).plugins.map(({ descriptor }) => descriptor.id),
      ).toContain('recruitment');
    }
    expect(
      resolveProductGraph('safe').plugins.map(({ descriptor }) => descriptor.id),
    ).not.toContain('recruitment');
  });

  it('publishes every explicit route permission in the architecture catalog', () => {
    const catalog = createArchitectureCatalog(resolveProductGraph('headless-server'));
    expect(catalog.routes.length).toBeGreaterThan(0);
    expect(catalog.routes.every((route) => Object.hasOwn(route, 'requiredPermission'))).toBe(true);
    expect(catalog.routes.find(({ id }) => id === 'getHealth')?.requiredPermission).toBeNull();
    expect(catalog.routes.find(({ id }) => id === 'updateTask')?.requiredPermission).toBe(
      'task.write',
    );
    expect(catalog.routes.find(({ id }) => id === 'listAuditEvents')?.requiredPermission).toBe(
      'audit.read',
    );
    expect(
      catalog.routes.find(({ id }) => id === 'listRecruitmentJobClusters')?.requiredPermission,
    ).toBe('workspace.read');
    expect(
      catalog.routes.find(({ id }) => id === 'createRecruitmentImport')?.requiredPermission,
    ).toBe('task.write');
    expect(
      catalog.routes.find(({ id }) => id === 'syncRecruitmentSource')?.requiredPermission,
    ).toBe('run.execute');
  });

  it('limits null permissions to the intentional bootstrap and public metadata surface', () => {
    const publicOperations = resolveProductGraph('headless-server').plugins.flatMap(
      ({ descriptor }) =>
        (descriptor.routes ?? [])
          .filter(({ requiredPermission }) => requiredPermission === null)
          .map(({ operationId }) => operationId),
    );
    expect(publicOperations.sort()).toEqual(
      [
        'acceptInvitation',
        'changePassword',
        'createSession',
        'getAuthStatus',
        'getCapabilities',
        'getHealth',
        'getProductOpenApi',
        'getReadiness',
        'getRuntime',
        'getRuntimeGraph',
        'getVersion',
        'login',
        'logout',
        'setupAuth',
      ].sort(),
    );
  });

  it('enforces the administrator, editor and viewer permission matrix from route declarations', () => {
    const routes = new Map(
      resolveProductGraph('headless-server').plugins.flatMap(({ descriptor }) =>
        (descriptor.routes ?? []).map((route) => [route.operationId, route.requiredPermission]),
      ),
    );
    const allowed = (role: IdentityRole, operationId: string): boolean => {
      const permission = routes.get(operationId);
      if (permission === undefined) throw new Error(`Unknown operation ${operationId}`);
      return (
        permission === null || rolePermissions[role].includes(permission as IdentityPermission)
      );
    };

    expect([...routes.keys()].every((operationId) => allowed('admin', operationId))).toBe(true);
    expect(allowed('editor', 'updateTask')).toBe(true);
    expect(allowed('editor', 'createRun')).toBe(true);
    expect(allowed('editor', 'createAnalysisJob')).toBe(true);
    expect(allowed('editor', 'retryDeliveryAttempt')).toBe(true);
    expect(allowed('editor', 'createOutputDestination')).toBe(false);
    expect(allowed('editor', 'createApiToken')).toBe(false);
    expect(allowed('editor', 'updateMember')).toBe(false);
    expect(allowed('editor', 'listAuditEvents')).toBe(false);
    expect(allowed('viewer', 'listTasks')).toBe(true);
    expect(allowed('viewer', 'exportDataset')).toBe(true);
    expect(allowed('viewer', 'updateTask')).toBe(false);
    expect(allowed('viewer', 'createRun')).toBe(false);
    expect(allowed('viewer', 'createAnalysisJob')).toBe(false);
  });
});
