import { describe, expect, it } from 'vitest';
import { hashOpaqueToken, hashPassword, verifyPassword } from '../src/application/security.js';
import {
  hasPermission,
  publicUser,
  redactAuditDetails,
  rolePermissions,
} from '../src/domain/index.js';

describe('identity security primitives', () => {
  it('uses versioned scrypt hashes and rejects malformed or wrong credentials', async () => {
    const encoded = await hashPassword('correct horse battery staple');
    expect(encoded).toMatch(/^scrypt\$v=1\$N=16384\$r=8\$p=1\$l=64\$/u);
    expect(encoded).not.toContain('correct horse');
    await expect(verifyPassword('correct horse battery staple', encoded)).resolves.toBe(true);
    await expect(verifyPassword('incorrect horse battery staple', encoded)).resolves.toBe(false);
    await expect(verifyPassword('anything', 'malformed')).resolves.toBe(false);
  });

  it('requires long passwords and hashes opaque tokens deterministically', async () => {
    await expect(hashPassword('too-short')).rejects.toThrow(/12 characters/u);
    expect(hashOpaqueToken('token')).toHaveLength(64);
    expect(hashOpaqueToken('token')).toBe(hashOpaqueToken('token'));
  });

  it('redacts nested secrets and never returns a password hash in public users', () => {
    const circular: Record<string, unknown> = {
      password: 'secret',
      nested: { serviceAccount: { private_key: 'private', client_email: 'x@example.com' } },
    };
    circular.self = circular;
    expect(redactAuditDetails(circular)).toEqual({
      password: '[REDACTED]',
      nested: { serviceAccount: '[REDACTED]' },
      self: '[CIRCULAR]',
    });
    const serialized = JSON.stringify(
      publicUser({
        id: 'user',
        email: 'user@example.com',
        displayName: 'User',
        passwordHash: 'must-not-leak',
        role: 'viewer',
        disabled: false,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }),
    );
    expect(serialized).not.toContain('must-not-leak');
  });

  it('keeps the fixed role permission matrix least-privileged', () => {
    expect(rolePermissions.admin).toContain('member.manage');
    expect(hasPermission('editor', 'output.bind')).toBe(true);
    expect(hasPermission('editor', 'output.manage')).toBe(false);
    expect(rolePermissions.viewer).toEqual(['workspace.read']);
  });
});
