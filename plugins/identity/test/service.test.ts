import { describe, expect, it } from 'vitest';
import { IdentityError, IdentityService } from '../src/application/index.js';
import { MemoryIdentityRepository } from './memory-repository.js';

const BOOTSTRAP_TOKEN = 'bootstrap-token-with-at-least-32-bytes-of-entropy';

describe('IdentityService', () => {
  it('can restart an initialized workspace without retaining a bootstrap token', async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(repository, {
      identifierPepper: 'stable-credential-key-used-as-identifier-pepper',
    });
    expect(await service.status()).toEqual({ initialized: false });
    await expect(
      service.bootstrapAdmin(
        {
          bootstrapToken: BOOTSTRAP_TOKEN,
          email: 'admin@example.com',
          displayName: 'Admin',
          password: 'correct horse battery staple',
        },
        { operationId: 'setupAuth' },
      ),
    ).rejects.toMatchObject({ status: 503, code: 'BOOTSTRAP_TOKEN_NOT_CONFIGURED' });
    await repository.createUser({
      email: 'existing@example.com',
      displayName: 'Existing Admin',
      passwordHash: 'unused-in-this-restart-test',
      role: 'admin',
    });
    expect(await service.status()).toEqual({ initialized: true });
  });

  it('bootstraps exactly one admin and stores only opaque session/CSRF hashes', async () => {
    const repository = new MemoryIdentityRepository();
    let now = new Date('2026-08-31T00:00:00.000Z');
    const service = new IdentityService(repository, {
      bootstrapToken: BOOTSTRAP_TOKEN,
      now: () => now,
    });
    expect(await service.status()).toEqual({ initialized: false });
    const admin = await service.bootstrapAdmin(
      {
        bootstrapToken: BOOTSTRAP_TOKEN,
        email: ' ADMIN@Example.COM ',
        displayName: 'Admin',
        password: 'correct horse battery staple',
      },
      { operationId: 'setupAuth', traceId: 'setup-trace', network: '127.0.0.1' },
    );
    expect(admin).toMatchObject({ email: 'admin@example.com', role: 'admin' });
    expect(JSON.stringify(admin)).not.toContain('passwordHash');
    expect(await service.status()).toEqual({ initialized: true });
    await expect(
      service.bootstrapAdmin(
        {
          bootstrapToken: BOOTSTRAP_TOKEN,
          email: 'other@example.com',
          displayName: 'Other',
          password: 'another correct horse battery',
        },
        { operationId: 'setupAuth' },
      ),
    ).rejects.toMatchObject({ code: 'ALREADY_INITIALIZED' });

    const login = await service.login(
      {
        email: 'admin@example.com',
        password: 'correct horse battery staple',
        network: '127.0.0.1',
      },
      { operationId: 'login', traceId: 'login-trace', network: '127.0.0.1' },
    );
    expect(JSON.stringify(repository.sessions)).not.toContain(login.sessionToken);
    expect(JSON.stringify(repository.sessions)).not.toContain(login.csrfToken);
    const principal = await service.authenticate(login.sessionToken);
    expect(principal.user.id).toBe(admin.id);
    expect(() => service.verifyCsrf(principal, login.csrfToken)).not.toThrow();
    expect(() => service.verifyCsrf(principal, 'wrong-csrf')).toThrowError(IdentityError);

    const resumed = await service.resumeSession(login.sessionToken);
    const secondTab = await service.resumeSession(login.sessionToken);
    expect(resumed.csrfToken).toBe(login.csrfToken);
    expect(secondTab.csrfToken).toBe(resumed.csrfToken);
    expect(JSON.stringify(repository.sessions)).not.toContain(resumed.csrfToken);
    expect(() => service.verifyCsrf(resumed.principal, resumed.csrfToken)).not.toThrow();
    expect(() => service.verifyCsrf(secondTab.principal, login.csrfToken)).not.toThrow();

    now = new Date(now.getTime() + 13 * 60 * 60 * 1_000);
    await expect(service.authenticate(login.sessionToken)).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
  });

  it('rate limits by email and network without revealing whether an account exists', async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(repository, {
      bootstrapToken: BOOTSTRAP_TOKEN,
      maxLoginFailures: 2,
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        service.login(
          { email: 'missing@example.com', password: 'wrong password value', network: '10.0.0.1' },
          { operationId: 'login', network: '10.0.0.1' },
        ),
      ).rejects.toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });
    }
    await expect(
      service.login(
        { email: 'missing@example.com', password: 'wrong password value', network: '10.0.0.1' },
        { operationId: 'login', network: '10.0.0.1' },
      ),
    ).rejects.toMatchObject({ status: 429, code: 'LOGIN_RATE_LIMITED' });
    expect(JSON.stringify(repository.loginAttempts)).not.toContain('missing@example.com');
    expect(JSON.stringify(repository.loginAttempts)).not.toContain('10.0.0.1');

    const malformedRepository = new MemoryIdentityRepository();
    const malformedService = new IdentityService(malformedRepository, {
      bootstrapToken: BOOTSTRAP_TOKEN,
      maxLoginFailures: 2,
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        malformedService.login(
          { email: 'not-an-email', password: 'wrong password value', network: '10.0.0.2' },
          { operationId: 'login', network: '10.0.0.2' },
        ),
      ).rejects.toMatchObject({
        status: 401,
        code: 'INVALID_CREDENTIALS',
        message: 'Email or password is invalid',
      });
    }
    await expect(
      malformedService.login(
        { email: 'not-an-email', password: 'wrong password value', network: '10.0.0.2' },
        { operationId: 'login', network: '10.0.0.2' },
      ),
    ).rejects.toMatchObject({ status: 429, code: 'LOGIN_RATE_LIMITED' });
    expect(malformedRepository.loginAttempts).toHaveLength(2);
  });

  it('returns the same credential failure for malformed, unknown, wrong and disabled accounts', async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(repository, {
      bootstrapToken: BOOTSTRAP_TOKEN,
      maxLoginFailures: 10,
    });
    const admin = await service.bootstrapAdmin(
      {
        bootstrapToken: BOOTSTRAP_TOKEN,
        email: 'admin@example.com',
        displayName: 'Admin',
        password: 'correct horse battery staple',
      },
      { operationId: 'setupAuth' },
    );

    const attempts = [
      service.login(
        { email: 'invalid', password: 'wrong password value', network: 'malformed' },
        { operationId: 'login', network: 'malformed' },
      ),
      service.login(
        { email: 'unknown@example.com', password: 'wrong password value', network: 'unknown' },
        { operationId: 'login', network: 'unknown' },
      ),
      service.login(
        { email: admin.email, password: 'wrong password value', network: 'wrong' },
        { operationId: 'login', network: 'wrong' },
      ),
    ];
    const failures = await Promise.all(
      attempts.map((attempt) =>
        attempt.catch((error: unknown) => {
          expect(error).toBeInstanceOf(IdentityError);
          const identityError = error as IdentityError;
          return {
            status: identityError.status,
            code: identityError.code,
            message: identityError.message,
          };
        }),
      ),
    );
    await repository.updateUser(admin.id, { disabled: true });
    const disabled = await service
      .login(
        { email: admin.email, password: 'correct horse battery staple', network: 'disabled' },
        { operationId: 'login', network: 'disabled' },
      )
      .catch((error: IdentityError) => ({
        status: error.status,
        code: error.code,
        message: error.message,
      }));

    expect([...failures, disabled]).toEqual(
      Array.from({ length: 4 }, () => ({
        status: 401,
        code: 'INVALID_CREDENTIALS',
        message: 'Email or password is invalid',
      })),
    );
  });

  it('atomically limits concurrent login failures and prunes expired attempts', async () => {
    const repository = new MemoryIdentityRepository();
    let now = new Date('2026-08-31T00:00:00.000Z');
    const service = new IdentityService(repository, {
      bootstrapToken: BOOTSTRAP_TOKEN,
      maxLoginFailures: 5,
      loginWindowMs: 60_000,
      now: () => now,
    });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        service.login(
          { email: 'missing@example.com', password: 'wrong password value', network: '10.0.0.2' },
          { operationId: 'login', network: '10.0.0.2' },
        ),
      ),
    );
    const codes = results.map((result) =>
      result.status === 'rejected' && result.reason instanceof IdentityError
        ? result.reason.code
        : 'unexpected',
    );
    expect(codes.filter((code) => code === 'INVALID_CREDENTIALS')).toHaveLength(5);
    expect(codes.filter((code) => code === 'LOGIN_RATE_LIMITED')).toHaveLength(15);
    expect(repository.loginAttempts).toHaveLength(5);

    now = new Date(now.getTime() + 60_001);
    await expect(
      service.login(
        { email: 'missing@example.com', password: 'wrong password value', network: '10.0.0.2' },
        { operationId: 'login', network: '10.0.0.2' },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(repository.loginAttempts).toHaveLength(1);
  });

  it('rate limits public token operations before hashing and audits every denial', async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(repository, {
      bootstrapToken: BOOTSTRAP_TOKEN,
      maxPublicTokenAttempts: 2,
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        service.acceptInvitation(
          {
            token: `invalid-${attempt}`,
            displayName: 'Attacker',
            password: 'correct horse battery staple',
          },
          { operationId: 'acceptInvitation', network: '198.51.100.2' },
        ),
      ).rejects.toMatchObject({ code: 'INVITATION_INVALID' });
    }
    await expect(
      service.acceptInvitation(
        {
          token: 'invalid-rate-limited',
          displayName: 'Attacker',
          password: 'correct horse battery staple',
        },
        { operationId: 'acceptInvitation', network: '198.51.100.2' },
      ),
    ).rejects.toMatchObject({ status: 429, code: 'IDENTITY_RATE_LIMITED' });
    expect(repository.audits.slice(-3)).toMatchObject([
      { operationId: 'acceptInvitation', result: 'denied' },
      { operationId: 'acceptInvitation', result: 'denied' },
      { operationId: 'acceptInvitation', result: 'denied' },
    ]);
    expect(JSON.stringify(repository.audits)).not.toContain('invalid-rate-limited');

    await expect(
      service.resetPassword('raw-token-never-audit', 'updated horse battery staple', {
        operationId: 'changePassword',
        network: '198.51.100.2',
      }),
    ).rejects.toMatchObject({ code: 'RESET_TOKEN_INVALID' });
    expect(repository.audits.at(-1)).toMatchObject({
      operationId: 'changePassword',
      result: 'denied',
      details: { reason: 'invalid-reset-token' },
    });
    expect(JSON.stringify(repository.audits.at(-1))).not.toContain('raw-token-never-audit');
  });

  it('enforces admin-only membership, single-use invitations/resets, and last-admin safety', async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(repository, { bootstrapToken: BOOTSTRAP_TOKEN });
    const admin = await service.bootstrapAdmin(
      {
        bootstrapToken: BOOTSTRAP_TOKEN,
        email: 'admin@example.com',
        displayName: 'Admin',
        password: 'correct horse battery staple',
      },
      { operationId: 'setupAuth' },
    );
    const adminLogin = await service.login(
      { email: admin.email, password: 'correct horse battery staple', network: 'local' },
      { operationId: 'login', network: 'local' },
    );
    const adminPrincipal = await service.authenticate(adminLogin.sessionToken);
    await service.recordOperation({
      actorUserId: admin.id,
      operationId: 'updateTask',
      resourceType: 'collection',
      resourceId: 'taskId=task-1',
      result: 'succeeded',
      statusCode: 200,
      traceId: 'trace-1',
      network: '192.0.2.10',
    });
    expect(repository.audits.at(-1)).toMatchObject({
      actorUserId: admin.id,
      operationId: 'updateTask',
      resourceType: 'collection',
      resourceId: 'taskId=task-1',
      result: 'succeeded',
      traceId: 'trace-1',
      details: { statusCode: 200 },
      networkHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(repository.audits.at(-1))).not.toContain('192.0.2.10');
    const created = await service.createInvitation(
      adminPrincipal,
      { email: 'editor@example.com', role: 'editor' },
      { operationId: 'createInvitation' },
    );
    expect(JSON.stringify(created.invitation)).not.toContain(created.token);
    const editor = await service.acceptInvitation(
      {
        token: created.token,
        displayName: 'Editor',
        password: 'editor horse battery staple',
      },
      { operationId: 'acceptInvitation' },
    );
    await expect(
      service.acceptInvitation(
        {
          token: created.token,
          displayName: 'Replay',
          password: 'editor horse battery staple',
        },
        { operationId: 'acceptInvitation' },
      ),
    ).rejects.toMatchObject({ code: 'INVITATION_INVALID' });

    const editorLogin = await service.login(
      { email: editor.email, password: 'editor horse battery staple', network: 'local-editor' },
      { operationId: 'login', network: 'local-editor' },
    );
    const editorPrincipal = await service.authenticate(editorLogin.sessionToken);
    await expect(service.listMembers(editorPrincipal)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      service.updateMember(
        adminPrincipal,
        admin.id,
        { disabled: true },
        { operationId: 'updateMember' },
      ),
    ).rejects.toMatchObject({ code: 'LAST_ADMIN_REQUIRED' });

    const reset = await service.createPasswordReset(adminPrincipal, editor.id, {
      operationId: 'createMemberPasswordReset',
    });
    await service.resetPassword(reset.token, 'updated horse battery staple', {
      operationId: 'changePassword',
    });
    await expect(service.authenticate(editorLogin.sessionToken)).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
    await expect(
      service.resetPassword(reset.token, 'replayed horse battery staple', {
        operationId: 'changePassword',
      }),
    ).rejects.toMatchObject({ code: 'RESET_TOKEN_INVALID' });
    await expect(
      service.login(
        { email: editor.email, password: 'updated horse battery staple', network: 'new-login' },
        { operationId: 'login', network: 'new-login' },
      ),
    ).resolves.toMatchObject({ user: { id: editor.id } });
  });
});
