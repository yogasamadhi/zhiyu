import { describe, expect, it } from 'vitest';
import { identityPlugin } from '../src/index.js';
import { identityRoutes } from '../src/http/index.js';
import { identitySqliteMigration001 } from '../src/migrations/sqlite/index.js';

describe('identity plugin declarations', () => {
  it('owns every SQLite identity table in its forward-only migration', () => {
    const tables = identityPlugin.migrations?.[0]?.tables ?? [];
    for (const table of tables) {
      expect(identitySqliteMigration001).toContain(`CREATE TABLE ${table}`);
    }
    expect(identitySqliteMigration001).toContain('token_hash TEXT NOT NULL UNIQUE');
    expect(identitySqliteMigration001).toContain("role IN ('admin','editor','viewer')");
    expect(identitySqliteMigration001).not.toMatch(/CREATE TABLE(?! identity_)/u);
  });

  it('declares a permission decision for every route operation', () => {
    expect(identityRoutes.every((route) => Object.hasOwn(route, 'requiredPermission'))).toBe(true);
    expect(
      identityRoutes.find(({ operationId }) => operationId === 'setupAuth')?.requiredPermission,
    ).toBeNull();
    expect(
      identityRoutes.find(({ operationId }) => operationId === 'updateMember')?.requiredPermission,
    ).toBe('member.manage');
    expect(
      identityRoutes.find(({ operationId }) => operationId === 'listAuditEvents')
        ?.requiredPermission,
    ).toBe('audit.read');
  });
});
