import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import { SqliteIdentityRepository } from '../src/index.js';

describe('SQLite identity persistence and atomic operations', () => {
  let directory: string;
  let platform: Awaited<ReturnType<typeof openSqlitePlatformRepository>>;
  let repository: SqliteIdentityRepository;
  let other: SqliteIdentityRepository;
  const admin = {
    email: 'admin@example.test',
    displayName: 'Admin',
    passwordHash: 'password-hash',
  };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'zhiyun-identity-sqlite-'));
    const filePath = join(directory, 'zhiyun.sqlite3');
    platform = await openSqlitePlatformRepository({
      dataDirectory: directory,
      filePath,
      graphRevision: 'identity-test',
    });
    repository = new SqliteIdentityRepository(filePath);
    other = new SqliteIdentityRepository(filePath);
    await repository.migrate();
    await other.migrate();
  });
  afterEach(async () => {
    await repository?.close();
    await other?.close();
    await platform?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('creates one bootstrap admin across connections and preserves the last active admin', async () => {
    const created = await Promise.all([
      repository.createBootstrapAdmin(admin),
      other.createBootstrapAdmin({ ...admin, email: 'second@example.test' }),
    ]);
    expect(created.filter(Boolean)).toHaveLength(1);
    const second = await other.createUser({
      ...admin,
      email: 'second@example.test',
      role: 'admin',
    });
    const attempts = await Promise.allSettled([
      repository.updateUser(created.find(Boolean)!.id, { role: 'viewer' }),
      other.updateUser(second.id, { disabled: true }),
    ]);
    expect(attempts.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(await repository.countActiveAdmins()).toBe(1);
    await repository.close();
    repository = new SqliteIdentityRepository(join(directory, 'zhiyun.sqlite3'));
    await repository.migrate();
    expect(await repository.countUsers()).toBe(2);
    expect(await repository.createBootstrapAdmin(admin)).toBeNull();
  });

  it('atomically admits only five failed login reservations across connections', async () => {
    const occurredAt = new Date();
    const windowStartsAt = new Date(occurredAt.getTime() - 900_000);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 ? repository : other).reserveFailedLoginSlot({
          emailHash: 'email-hash',
          networkHash: 'network-hash',
          occurredAt,
          windowStartsAt,
          maximumFailures: 5,
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(
      await repository.countRecentFailedLogins('email-hash', 'network-hash', windowStartsAt),
    ).toBe(5);
    await repository.clearLoginFailures('email-hash', 'network-hash');
    expect(await other.countRecentFailedLogins('email-hash', 'network-hash', windowStartsAt)).toBe(
      0,
    );
  });

  it('persists session expiry, CSRF rotation and revocation', async () => {
    const user = (await repository.createBootstrapAdmin(admin))!;
    const now = new Date();
    const absolute = new Date(now.getTime() + 120_000);
    await repository.createSession({
      userId: user.id,
      tokenHash: 'token-hash',
      csrfTokenHash: 'csrf-hash',
      idleExpiresAt: new Date(now.getTime() + 30_000),
      absoluteExpiresAt: absolute,
    });
    const renewed = await other.activateSession(
      'token-hash',
      now,
      new Date(now.getTime() + 300_000),
    );
    expect(renewed?.idleExpiresAt).toBe(absolute.toISOString());
    expect(
      (await repository.rotateSessionCsrf('token-hash', 'new-csrf-hash', now))?.csrfTokenHash,
    ).toBe('new-csrf-hash');
    expect(await other.revokeUserSessions(user.id, now)).toBe(1);
    expect(await repository.activateSession('token-hash', now, absolute)).toBeNull();
    expect(await repository.revokeSession('token-hash', now)).toBe(false);
  });

  it('consumes invitations and password reset tokens once and ignores revoked or expired tokens', async () => {
    const owner = (await repository.createBootstrapAdmin(admin))!;
    const at = new Date();
    const expiresAt = new Date(at.getTime() + 60_000);
    const invitation = {
      email: 'viewer@example.test',
      role: 'viewer' as const,
      createdBy: owner.id,
      expiresAt,
    };
    await repository.createInvitation({ ...invitation, tokenHash: 'obsolete' });
    await other.createInvitation({ ...invitation, tokenHash: 'current' });
    expect(await repository.isInvitationTokenActive('obsolete', at)).toBe(false);
    const accepted = await Promise.all(
      [repository, other].map((repo) =>
        repo.consumeInvitation({
          tokenHash: 'current',
          displayName: 'Viewer',
          passwordHash: 'old-hash',
          at,
        }),
      ),
    );
    expect(accepted.filter(Boolean)).toHaveLength(1);
    const user = accepted.find(Boolean)!;
    await repository.createPasswordReset({
      userId: user.id,
      tokenHash: 'reset',
      expiresAt,
      createdBy: owner.id,
    });
    const reset = await Promise.all(
      [repository, other].map((repo) => repo.consumePasswordReset('reset', 'new-hash', at)),
    );
    expect(reset.filter(Boolean)).toHaveLength(1);
    expect((await other.findUserById(user.id))?.passwordHash).toBe('new-hash');
    expect(await repository.isPasswordResetTokenActive('reset', at)).toBe(false);
    await repository.createInvitation({
      ...invitation,
      email: 'expired@example.test',
      tokenHash: 'expired',
      expiresAt: new Date(at.getTime() - 1),
    });
    expect(
      await other.consumeInvitation({
        tokenHash: 'expired',
        displayName: 'Expired',
        passwordHash: 'hash',
        at,
      }),
    ).toBeNull();
  });

  it('restores structured audit events and pages entries with identical timestamps', async () => {
    const occurredAt = new Date();
    for (let index = 0; index < 3; index++)
      await repository.createAuditEvent({
        actorUserId: null,
        operationId: 'test',
        resourceType: 'workspace',
        resourceId: null,
        result: 'succeeded',
        traceId: null,
        networkHash: null,
        details: { index },
        occurredAt,
      });
    const first = await repository.listAuditEvents(undefined, 2);
    const second = await other.listAuditEvents(first.nextCursor!, 2);
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(3);
    expect(first.items[0]?.details).toEqual({ index: expect.any(Number) });
    expect(second.nextCursor).toBeNull();
    await expect(repository.listAuditEvents('invalid')).rejects.toThrow('Invalid audit cursor');
  });
});
