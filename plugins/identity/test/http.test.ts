import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { IdentityService } from '../src/application/index.js';
import { registerIdentityHttp } from '../src/http/index.js';
import { MemoryIdentityRepository } from './memory-repository.js';

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('identity HTTP routes', () => {
  it('uses HttpOnly sessions, CSRF protection, permission checks and RFC 7807 errors', async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(repository, {
      bootstrapToken: 'bootstrap-token-with-at-least-32-bytes-of-entropy',
    });
    const app = Fastify();
    apps.push(app);
    await registerIdentityHttp(app, service, { secureCookies: false });

    const setup = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/setup',
      payload: {
        bootstrapToken: 'bootstrap-token-with-at-least-32-bytes-of-entropy',
        email: 'admin@example.com',
        displayName: 'Admin',
        password: 'correct horse battery staple',
      },
    });
    expect(setup.statusCode).toBe(201);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { email: 'admin@example.com', password: 'correct horse battery staple' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.headers['cache-control']).toBe('no-store');
    expect(login.headers['set-cookie']).toContain('HttpOnly');
    expect(login.headers['set-cookie']).toContain('SameSite=Strict');
    const loginCookieHeader = login.headers['set-cookie'];
    const cookie = (
      Array.isArray(loginCookieHeader) ? loginCookieHeader[0] : loginCookieHeader
    )?.split(';')[0];
    const csrfToken = login.json().csrfToken as string;

    const missingCsrf = await app.inject({
      method: 'POST',
      url: '/api/v2/invitations',
      headers: { cookie: cookie ?? '' },
      payload: { email: 'viewer@example.com', role: 'viewer' },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.headers['content-type']).toContain('application/problem+json');
    expect(missingCsrf.json()).toMatchObject({ code: 'CSRF_INVALID', status: 403 });

    const resumed = await app.inject({
      method: 'GET',
      url: '/api/v2/auth/me',
      headers: { cookie: cookie ?? '' },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.headers['cache-control']).toBe('no-store');
    expect(resumed.json()).toMatchObject({
      user: { email: 'admin@example.com' },
      permissions: expect.arrayContaining(['workspace.read', 'member.manage']),
      idleExpiresAt: expect.any(String),
      absoluteExpiresAt: expect.any(String),
    });
    const resumedCsrfToken = resumed.json().csrfToken as string;
    const secondTab = await app.inject({
      method: 'GET',
      url: '/api/v2/auth/me',
      headers: { cookie: cookie ?? '' },
    });
    const secondTabCsrfToken = secondTab.json().csrfToken as string;
    expect(resumedCsrfToken).toBe(csrfToken);
    expect(secondTabCsrfToken).toBe(resumedCsrfToken);

    const invitation = await app.inject({
      method: 'POST',
      url: '/api/v2/invitations',
      headers: { cookie: cookie ?? '', 'x-csrf-token': resumedCsrfToken },
      payload: { email: 'viewer@example.com', role: 'viewer' },
    });
    expect(invitation.statusCode).toBe(201);
    const secondTabMutation = await app.inject({
      method: 'POST',
      url: '/api/v2/invitations',
      headers: { cookie: cookie ?? '', 'x-csrf-token': secondTabCsrfToken },
      payload: { email: 'other-viewer@example.com', role: 'viewer' },
    });
    expect(secondTabMutation.statusCode).toBe(201);
    const token = invitation.json().token as string;
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v2/invitations/accept',
      payload: {
        token,
        displayName: 'Viewer',
        password: 'viewer horse battery staple',
      },
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json()).toMatchObject({ role: 'viewer' });

    const viewerLogin = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { email: 'viewer@example.com', password: 'viewer horse battery staple' },
    });
    const viewerCookieHeader = viewerLogin.headers['set-cookie'];
    const viewerCookie = (
      Array.isArray(viewerCookieHeader) ? viewerCookieHeader[0] : viewerCookieHeader
    )?.split(';')[0];
    const members = await app.inject({
      method: 'GET',
      url: '/api/v2/members',
      headers: { cookie: viewerCookie ?? '' },
    });
    expect(members.statusCode).toBe(403);
    expect(members.json()).toMatchObject({ code: 'FORBIDDEN' });

    const rejectedLogout = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/logout',
      headers: { cookie: cookie ?? '' },
    });
    expect(rejectedLogout.statusCode).toBe(403);
    expect(rejectedLogout.headers['set-cookie']).toBeUndefined();

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/logout',
      headers: { cookie: cookie ?? '', 'x-csrf-token': resumedCsrfToken },
    });
    expect(logout.statusCode).toBe(204);
    expect(logout.headers['set-cookie']).toContain('Max-Age=0');
    expect(
      typeof repository.sessions.find((session) => session.userId === setup.json().id)?.revokedAt,
    ).toBe('string');

    const afterLogout = await app.inject({
      method: 'GET',
      url: '/api/v2/auth/me',
      headers: { cookie: cookie ?? '' },
    });
    expect(afterLogout.statusCode).toBe(401);
    expect(afterLogout.json()).toMatchObject({ code: 'SESSION_EXPIRED' });

    const repeatedLogout = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/logout',
      headers: { cookie: cookie ?? '' },
    });
    expect(repeatedLogout.statusCode).toBe(204);
    expect(repeatedLogout.headers['set-cookie']).toContain('Max-Age=0');
  });

  it('lets a signed-in user change their password and revokes the active Cookie session', async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(repository, {
      bootstrapToken: 'bootstrap-token-with-at-least-32-bytes-of-entropy',
    });
    const app = Fastify();
    apps.push(app);
    await registerIdentityHttp(app, service, { secureCookies: false });

    await app.inject({
      method: 'POST',
      url: '/api/v2/auth/setup',
      payload: {
        bootstrapToken: 'bootstrap-token-with-at-least-32-bytes-of-entropy',
        email: 'admin@example.com',
        displayName: 'Admin',
        password: 'correct horse battery staple',
      },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/login',
      payload: { email: 'admin@example.com', password: 'correct horse battery staple' },
    });
    const cookieHeader = login.headers['set-cookie'];
    const cookie = (Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader)?.split(';')[0];
    const resumed = await app.inject({
      method: 'GET',
      url: '/api/v2/auth/me',
      headers: { cookie: cookie ?? '' },
    });

    const changed = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/password',
      headers: { cookie: cookie ?? '', 'x-csrf-token': resumed.json().csrfToken as string },
      payload: {
        currentPassword: 'correct horse battery staple',
        newPassword: 'new correct horse battery staple',
      },
    });
    expect(changed.statusCode).toBe(204);
    expect(changed.headers['set-cookie']).toContain('Max-Age=0');
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v2/auth/me',
          headers: { cookie: cookie ?? '' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v2/auth/login',
          payload: {
            email: 'admin@example.com',
            password: 'new correct horse battery staple',
          },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('returns an indistinguishable problem response for every invalid credential shape', async () => {
    const repository = new MemoryIdentityRepository();
    const service = new IdentityService(repository, {
      bootstrapToken: 'bootstrap-token-with-at-least-32-bytes-of-entropy',
      maxLoginFailures: 10,
    });
    const app = Fastify();
    apps.push(app);
    await registerIdentityHttp(app, service, { secureCookies: false });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v2/auth/setup',
      payload: {
        bootstrapToken: 'bootstrap-token-with-at-least-32-bytes-of-entropy',
        email: 'admin@example.com',
        displayName: 'Admin',
        password: 'correct horse battery staple',
      },
    });

    const malformed = await loginProblem(app, 'not-an-email', 'wrong password value');
    const empty = await loginProblem(app, '', '');
    const unknown = await loginProblem(app, 'unknown@example.com', 'wrong password value');
    const wrong = await loginProblem(app, 'admin@example.com', 'wrong password value');
    await repository.updateUser(setup.json().id as string, { disabled: true });
    const disabled = await loginProblem(app, 'admin@example.com', 'correct horse battery staple');

    expect([malformed, empty, unknown, wrong, disabled]).toEqual(
      Array.from({ length: 5 }, () => ({
        statusCode: 401,
        type: 'https://zhiyun.dev/problems/invalid-credentials',
        title: 'INVALID_CREDENTIALS',
        status: 401,
        code: 'INVALID_CREDENTIALS',
        detail: 'Email or password is invalid',
        instance: '/api/v2/auth/login',
      })),
    );
  });
});

async function loginProblem(
  app: ReturnType<typeof Fastify>,
  email: string,
  password: string,
): Promise<Record<string, unknown>> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v2/auth/login',
    payload: { email, password },
  });
  const problem = response.json() as Record<string, unknown>;
  delete problem.traceId;
  return { statusCode: response.statusCode, ...problem };
}
