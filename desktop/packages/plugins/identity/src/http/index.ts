import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RouteContribution } from '@zhiyun/kernel';
import { IdentityError } from '../application/index.js';
import type { IdentityService } from '../application/index.js';
import {
  identityRoles,
  rolePermissions,
  type IdentityPrincipal,
  type IdentityRole,
} from '../domain/index.js';

export const identityRoutes = [
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
  { operationId: 'login', method: 'POST', path: '/api/v2/auth/login', requiredPermission: null },
  {
    operationId: 'logout',
    method: 'POST',
    path: '/api/v2/auth/logout',
    // The handler performs session authentication and CSRF validation itself so an expired
    // Cookie can still be cleared idempotently instead of being rejected by the gateway first.
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
] as const satisfies readonly RouteContribution[];

export type IdentityOperationId = (typeof identityRoutes)[number]['operationId'];

export interface IdentityHttpOptions {
  readonly secureCookies?: boolean;
  readonly sessionCookieName?: string;
}

export async function registerIdentityHttp(
  app: FastifyInstance,
  service: IdentityService,
  options: IdentityHttpOptions = {},
): Promise<void> {
  const cookieName = options.sessionCookieName ?? 'zhiyun_session';
  const secureCookies = options.secureCookies ?? true;

  app.get('/api/v2/auth/status', async (_request, reply) => send(reply, () => service.status()));

  app.post('/api/v2/auth/setup', async (request, reply) =>
    send(reply, async () => {
      const body = objectBody(request);
      const user = await service.bootstrapAdmin(
        {
          bootstrapToken: stringField(body, 'bootstrapToken'),
          email: stringField(body, 'email'),
          displayName: stringField(body, 'displayName'),
          password: stringField(body, 'password'),
        },
        context(request, 'setupAuth'),
      );
      reply.code(201);
      return user;
    }),
  );

  app.post('/api/v2/auth/login', async (request, reply) =>
    send(reply, async () => {
      reply.header('cache-control', 'no-store');
      const body = objectBody(request);
      const result = await service.login(
        {
          // Credential shape is intentionally normalized into the service's generic failure path
          // instead of exposing email/password validation details before dummy-hash verification.
          email: loginCredentialField(body.email),
          password: loginCredentialField(body.password),
          network: request.ip,
        },
        context(request, 'login'),
      );
      reply.header(
        'set-cookie',
        sessionCookie(cookieName, result.sessionToken, secureCookies, 7 * 24 * 60 * 60),
      );
      return {
        user: result.user,
        csrfToken: result.csrfToken,
        idleExpiresAt: result.idleExpiresAt,
        absoluteExpiresAt: result.absoluteExpiresAt,
      };
    }),
  );

  app.post('/api/v2/auth/logout', async (request, reply) =>
    send(reply, async () => {
      const token = cookie(request, cookieName);
      if (!token) {
        reply.header('set-cookie', expiredSessionCookie(cookieName, secureCookies));
        reply.code(204);
        return undefined;
      }
      let principal: IdentityPrincipal;
      try {
        principal = await service.authenticate(token);
      } catch (error) {
        if (error instanceof IdentityError && error.status === 401) {
          reply.header('set-cookie', expiredSessionCookie(cookieName, secureCookies));
          reply.code(204);
          return undefined;
        }
        throw error;
      }
      const csrf = request.headers['x-csrf-token'];
      service.verifyCsrf(principal, Array.isArray(csrf) ? csrf[0] : csrf);
      // Clear the browser credential even if audit persistence fails after the session has been
      // revoked. Authentication and CSRF validation have already completed at this point.
      reply.header('set-cookie', expiredSessionCookie(cookieName, secureCookies));
      await service.logout(token, principal, context(request, 'logout', principal.user.id));
      reply.code(204);
      return undefined;
    }),
  );

  app.get('/api/v2/auth/me', async (request, reply) =>
    send(reply, async () => {
      reply.header('cache-control', 'no-store');
      const token = requiredSessionToken(request, cookieName);
      const { principal, csrfToken } = await service.resumeSession(token);
      return {
        user: principal.user,
        permissions: rolePermissions[principal.user.role],
        csrfToken,
        idleExpiresAt: principal.session.idleExpiresAt,
        absoluteExpiresAt: principal.session.absoluteExpiresAt,
      };
    }),
  );

  app.post('/api/v2/auth/password', async (request, reply) =>
    send(reply, async () => {
      const body = objectBody(request);
      if (typeof body.resetToken === 'string') {
        await service.resetPassword(
          body.resetToken,
          stringField(body, 'newPassword'),
          context(request, 'changePassword'),
        );
      } else {
        const { principal } = await requireAuth(request, service, cookieName, true);
        await service.changePassword(
          principal,
          stringField(body, 'currentPassword'),
          stringField(body, 'newPassword'),
          context(request, 'changePassword', principal.user.id),
        );
        reply.header('set-cookie', expiredSessionCookie(cookieName, secureCookies));
      }
      reply.code(204);
      return undefined;
    }),
  );

  app.get('/api/v2/members', async (request, reply) =>
    send(reply, async () => {
      const { principal } = await requireAuth(request, service, cookieName, false);
      return { items: await service.listMembers(principal) };
    }),
  );

  app.patch('/api/v2/members/:memberId', async (request, reply) =>
    send(reply, async () => {
      const { principal } = await requireAuth(request, service, cookieName, true);
      const body = objectBody(request);
      const role = optionalRole(body.role);
      const disabled = optionalBoolean(body.disabled, 'disabled');
      const displayName = optionalString(body.displayName, 'displayName');
      return service.updateMember(
        principal,
        pathId(request, 'memberId'),
        {
          ...(role === undefined ? {} : { role }),
          ...(disabled === undefined ? {} : { disabled }),
          ...(displayName === undefined ? {} : { displayName }),
        },
        context(request, 'updateMember', principal.user.id),
      );
    }),
  );

  app.post('/api/v2/members/:memberId/password-reset', async (request, reply) =>
    send(reply, async () => {
      const { principal } = await requireAuth(request, service, cookieName, true);
      reply.code(201);
      return service.createPasswordReset(
        principal,
        pathId(request, 'memberId'),
        context(request, 'createMemberPasswordReset', principal.user.id),
      );
    }),
  );

  app.get('/api/v2/invitations', async (request, reply) =>
    send(reply, async () => {
      const { principal } = await requireAuth(request, service, cookieName, false);
      return { items: await service.listInvitations(principal) };
    }),
  );

  app.post('/api/v2/invitations', async (request, reply) =>
    send(reply, async () => {
      const { principal } = await requireAuth(request, service, cookieName, true);
      const body = objectBody(request);
      reply.code(201);
      return service.createInvitation(
        principal,
        { email: stringField(body, 'email'), role: roleField(body, 'role') },
        context(request, 'createInvitation', principal.user.id),
      );
    }),
  );

  app.delete('/api/v2/invitations/:invitationId', async (request, reply) =>
    send(reply, async () => {
      const { principal } = await requireAuth(request, service, cookieName, true);
      await service.revokeInvitation(
        principal,
        pathId(request, 'invitationId'),
        context(request, 'deleteInvitation', principal.user.id),
      );
      reply.code(204);
      return undefined;
    }),
  );

  app.post('/api/v2/invitations/accept', async (request, reply) =>
    send(reply, async () => {
      const body = objectBody(request);
      const user = await service.acceptInvitation(
        {
          token: stringField(body, 'token'),
          displayName: stringField(body, 'displayName'),
          password: stringField(body, 'password'),
        },
        context(request, 'acceptInvitation'),
      );
      reply.code(201);
      return user;
    }),
  );

  app.get('/api/v2/audit-events', async (request, reply) =>
    send(reply, async () => {
      const { principal } = await requireAuth(request, service, cookieName, false);
      const query = request.query as { cursor?: string; limit?: string };
      return service.listAuditEvents(principal, query.cursor, parseLimit(query.limit));
    }),
  );
}

async function requireAuth(
  request: FastifyRequest,
  service: IdentityService,
  cookieName: string,
  mutation: boolean,
): Promise<{ principal: IdentityPrincipal; token: string }> {
  const token = requiredSessionToken(request, cookieName);
  const principal = await service.authenticate(token);
  if (mutation) {
    const csrf = request.headers['x-csrf-token'];
    service.verifyCsrf(principal, Array.isArray(csrf) ? csrf[0] : csrf);
  }
  return { principal, token };
}

function requiredSessionToken(request: FastifyRequest, cookieName: string): string {
  const token = cookie(request, cookieName);
  if (!token) throw new IdentityError(401, 'AUTHENTICATION_REQUIRED', 'Login is required');
  return token;
}

async function send(reply: FastifyReply, operation: () => Promise<unknown>): Promise<unknown> {
  try {
    return await operation();
  } catch (error) {
    const status = error instanceof IdentityError ? error.status : 400;
    const code = error instanceof IdentityError ? error.code : 'VALIDATION_ERROR';
    const detail = error instanceof Error ? error.message : 'Identity request failed';
    return reply
      .code(status)
      .type('application/problem+json')
      .send({
        type: `https://zhiyun.dev/problems/${code.toLowerCase().replaceAll('_', '-')}`,
        title: code,
        status,
        code,
        detail,
        instance: reply.request.routeOptions.url || reply.request.url.split('?')[0],
        traceId: reply.request.id,
      });
  }
}

function context(request: FastifyRequest, operationId: IdentityOperationId, actorUserId?: string) {
  return {
    operationId,
    traceId: request.id,
    network: request.ip,
    ...(actorUserId ? { actorUserId } : {}),
  };
}

function objectBody(request: FastifyRequest): Record<string, unknown> {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    throw new IdentityError(400, 'VALIDATION_ERROR', 'A JSON object body is required');
  }
  return request.body as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value) {
    throw new IdentityError(400, 'VALIDATION_ERROR', `${key} is required`);
  }
  return value;
}

function loginCredentialField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalString(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new IdentityError(400, 'VALIDATION_ERROR', `${key} must be a string`);
  }
  return value;
}

function optionalBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new IdentityError(400, 'VALIDATION_ERROR', `${key} must be a boolean`);
  }
  return value;
}

function roleField(body: Record<string, unknown>, key: string): IdentityRole {
  const value = body[key];
  if (typeof value !== 'string' || !identityRoles.includes(value as IdentityRole)) {
    throw new IdentityError(400, 'VALIDATION_ERROR', `${key} must be admin, editor or viewer`);
  }
  return value as IdentityRole;
}

function optionalRole(value: unknown): IdentityRole | undefined {
  return value === undefined ? undefined : roleField({ role: value }, 'role');
}

function pathId(request: FastifyRequest, key: string): string {
  const value = (request.params as Record<string, unknown>)[key];
  if (typeof value !== 'string' || !value) {
    throw new IdentityError(400, 'VALIDATION_ERROR', `Invalid ${key}`);
  }
  return value;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new IdentityError(400, 'VALIDATION_ERROR', 'limit must be between 1 and 500');
  }
  return parsed;
}

function cookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function sessionCookie(name: string, token: string, secure: boolean, maxAge: number): string {
  return `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function expiredSessionCookie(name: string, secure: boolean): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}
