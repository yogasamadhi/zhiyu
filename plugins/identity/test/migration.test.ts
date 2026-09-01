import { describe, expect, it } from 'vitest';
import { identityPlugin } from '../src/index.js';
import { identityRoutes } from '../src/http/index.js';
import { identityPostgresMigration001 } from '../src/migrations/postgres/index.js';

describe('identity plugin declarations', () => {
  it('owns every PostgreSQL identity table in its forward-only migration', () => {
    const tables = identityPlugin.migrations?.[0]?.tables ?? [];
    for (const table of tables) {
      expect(identityPostgresMigration001).toContain(`CREATE TABLE ${table}`);
    }
    expect(identityPostgresMigration001).toContain('token_hash TEXT NOT NULL UNIQUE');
    expect(identityPostgresMigration001).toContain("role IN ('admin','editor','viewer')");
    expect(identityPostgresMigration001).not.toMatch(/CREATE TABLE(?! identity_)/u);
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
