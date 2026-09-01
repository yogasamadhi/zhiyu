import { Buffer } from 'node:buffer';
import type { AuditPage, IdentityRepository, IdentityServiceContract } from '../contracts/index.js';
import {
  hashPrivateIdentifier,
  hasPermission,
  normalizeEmail,
  publicUser,
  redactAuditDetails,
  type AuditResult,
  type IdentityInvitation,
  type IdentityPermission,
  type IdentityPrincipal,
  type IdentityRole,
  type PublicIdentityUser,
} from '../domain/index.js';
import {
  constantTimeTextEqual,
  hashOpaqueToken,
  hashPassword,
  issueOpaqueToken,
  validatePassword,
  verifyPassword,
} from './security.js';

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

export interface IdentityServiceOptions {
  readonly bootstrapToken?: string;
  readonly legacyAdminToken?: string;
  readonly identifierPepper?: string;
  readonly sessionIdleMs?: number;
  readonly sessionAbsoluteMs?: number;
  readonly invitationTtlMs?: number;
  readonly passwordResetTtlMs?: number;
  readonly loginWindowMs?: number;
  readonly maxLoginFailures?: number;
  readonly publicTokenWindowMs?: number;
  readonly maxPublicTokenAttempts?: number;
  readonly now?: () => Date;
}

export interface IdentityRequestContext {
  readonly operationId: string;
  readonly traceId?: string;
  readonly network?: string;
  readonly actorUserId?: string;
}

export type PublicInvitation = Omit<IdentityInvitation, 'tokenHash'>;

export class IdentityError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class IdentityService implements IdentityServiceContract {
  private readonly bootstrapToken: string | undefined;
  private readonly legacyAdminToken: string | undefined;
  private readonly identifierPepper: string;
  private readonly sessionIdleMs: number;
  private readonly sessionAbsoluteMs: number;
  private readonly invitationTtlMs: number;
  private readonly passwordResetTtlMs: number;
  private readonly loginWindowMs: number;
  private readonly maxLoginFailures: number;
  private readonly publicTokenWindowMs: number;
  private readonly maxPublicTokenAttempts: number;
  private readonly clock: () => Date;
  private dummyPasswordHash: Promise<string> | undefined;

  constructor(
    private readonly repository: IdentityRepository,
    options: IdentityServiceOptions,
  ) {
    if (
      options.bootstrapToken !== undefined &&
      Buffer.byteLength(options.bootstrapToken, 'utf8') < 32
    ) {
      throw new Error('ZHIYUN_BOOTSTRAP_TOKEN must contain at least 32 bytes');
    }
    this.bootstrapToken = options.bootstrapToken;
    this.legacyAdminToken = options.legacyAdminToken;
    this.identifierPepper =
      options.identifierPepper ?? options.bootstrapToken ?? options.legacyAdminToken ?? '';
    if (!this.identifierPepper) {
      throw new Error(
        'Identity identifierPepper is required when no bootstrap token is configured',
      );
    }
    this.sessionIdleMs = positive(options.sessionIdleMs ?? 12 * HOUR, 'sessionIdleMs');
    this.sessionAbsoluteMs = positive(options.sessionAbsoluteMs ?? 7 * DAY, 'sessionAbsoluteMs');
    this.invitationTtlMs = positive(options.invitationTtlMs ?? 72 * HOUR, 'invitationTtlMs');
    this.passwordResetTtlMs = positive(options.passwordResetTtlMs ?? HOUR, 'passwordResetTtlMs');
    this.loginWindowMs = positive(options.loginWindowMs ?? 15 * 60 * 1_000, 'loginWindowMs');
    this.maxLoginFailures = positive(options.maxLoginFailures ?? 5, 'maxLoginFailures');
    this.publicTokenWindowMs = positive(
      options.publicTokenWindowMs ?? 15 * 60 * 1_000,
      'publicTokenWindowMs',
    );
    this.maxPublicTokenAttempts = positive(
      options.maxPublicTokenAttempts ?? 20,
      'maxPublicTokenAttempts',
    );
    if (this.sessionIdleMs > this.sessionAbsoluteMs) {
      throw new Error('Session idle expiry cannot exceed absolute expiry');
    }
    this.clock = options.now ?? (() => new Date());
  }

  async status(): Promise<{ initialized: boolean }> {
    return { initialized: (await this.repository.countUsers()) > 0 };
  }

  async bootstrapAdmin(
    input: { bootstrapToken: string; email: string; displayName: string; password: string },
    context: IdentityRequestContext,
  ): Promise<PublicIdentityUser> {
    if ((await this.repository.countUsers()) > 0) {
      throw new IdentityError(
        409,
        'ALREADY_INITIALIZED',
        'Workspace identity is already initialized',
      );
    }
    if (this.bootstrapToken === undefined && this.legacyAdminToken === undefined) {
      await this.audit(context, 'workspace', null, 'denied', {
        reason: 'bootstrap-token-not-configured',
      });
      throw new IdentityError(
        503,
        'BOOTSTRAP_TOKEN_NOT_CONFIGURED',
        'Workspace initialization requires a bootstrap token in the server environment',
      );
    }
    const accepted =
      (this.bootstrapToken !== undefined &&
        constantTimeTextEqual(input.bootstrapToken, this.bootstrapToken)) ||
      (this.legacyAdminToken !== undefined &&
        constantTimeTextEqual(input.bootstrapToken, this.legacyAdminToken));
    if (!accepted) {
      await this.audit(context, 'workspace', null, 'denied', { reason: 'invalid-bootstrap-token' });
      throw new IdentityError(401, 'INVALID_BOOTSTRAP_TOKEN', 'Bootstrap token is invalid');
    }
    const email = parseEmail(input.email);
    const passwordHash = await hashPassword(input.password);
    const user = await this.repository.createBootstrapAdmin({
      email,
      displayName: requiredName(input.displayName),
      passwordHash,
    });
    if (!user) {
      throw new IdentityError(
        409,
        'ALREADY_INITIALIZED',
        'Workspace identity is already initialized',
      );
    }
    await this.audit({ ...context, actorUserId: user.id }, 'member', user.id, 'succeeded', {
      role: 'admin',
      bootstrap: true,
    });
    return publicUser(user);
  }

  async login(
    input: { email: string; password: string; network?: string },
    context: IdentityRequestContext,
  ): Promise<{
    user: PublicIdentityUser;
    sessionToken: string;
    csrfToken: string;
    idleExpiresAt: string;
    absoluteExpiresAt: string;
  }> {
    const parsedEmail = loginEmail(input.email);
    const email = parsedEmail.email;
    const network = input.network ?? context.network ?? 'unknown';
    const emailHash = hashPrivateIdentifier(parsedEmail.rateLimitIdentifier, this.identifierPepper);
    const networkHash = hashPrivateIdentifier(network, this.identifierPepper);
    const now = this.clock();
    const reserved = await this.repository.reserveFailedLoginSlot({
      emailHash,
      networkHash,
      occurredAt: now,
      windowStartsAt: new Date(now.getTime() - this.loginWindowMs),
      maximumFailures: this.maxLoginFailures,
    });
    if (!reserved) {
      await this.audit(context, 'session', null, 'denied', { reason: 'rate-limited' });
      throw new IdentityError(
        429,
        'LOGIN_RATE_LIMITED',
        'Too many login attempts; try again later',
      );
    }

    // Invalid email syntax follows the same database lookup and dummy-hash path as an unknown
    // account. Credential failures must not expose account existence or validation details.
    const user = await this.repository.findUserByEmail(parsedEmail.lookupValue);
    const valid = await verifyPassword(
      input.password,
      user?.passwordHash ?? (await this.getDummyPasswordHash()),
    );
    if (!email || !user || !valid || user.disabled) {
      await this.audit(context, 'session', null, 'denied', { reason: 'invalid-credentials' });
      throw new IdentityError(401, 'INVALID_CREDENTIALS', 'Email or password is invalid');
    }

    await this.repository.recordLoginAttempt({
      emailHash,
      networkHash,
      succeeded: true,
      occurredAt: now,
    });
    await this.repository.clearLoginFailures(emailHash, networkHash);
    const sessionToken = issueOpaqueToken();
    const csrfToken = this.sessionCsrfToken(sessionToken);
    const absoluteExpiresAt = new Date(now.getTime() + this.sessionAbsoluteMs);
    const idleExpiresAt = new Date(now.getTime() + this.sessionIdleMs);
    const session = await this.repository.createSession({
      userId: user.id,
      tokenHash: hashOpaqueToken(sessionToken),
      csrfTokenHash: hashOpaqueToken(csrfToken),
      idleExpiresAt,
      absoluteExpiresAt,
    });
    await this.audit({ ...context, actorUserId: user.id }, 'session', session.id, 'succeeded', {});
    return {
      user: publicUser(user),
      sessionToken,
      csrfToken,
      idleExpiresAt: session.idleExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
    };
  }

  async authenticate(sessionToken: string, at = this.clock()): Promise<IdentityPrincipal> {
    if (!sessionToken) throw new IdentityError(401, 'AUTHENTICATION_REQUIRED', 'Login is required');
    const session = await this.repository.activateSession(
      hashOpaqueToken(sessionToken),
      at,
      new Date(at.getTime() + this.sessionIdleMs),
    );
    if (!session) throw new IdentityError(401, 'SESSION_EXPIRED', 'Session is invalid or expired');
    const user = await this.repository.findUserById(session.userId);
    if (!user || user.disabled) {
      await this.repository.revokeSession(hashOpaqueToken(sessionToken), at);
      throw new IdentityError(401, 'SESSION_EXPIRED', 'Session is invalid or expired');
    }
    return { user: publicUser(user), session };
  }

  async resumeSession(sessionToken: string): Promise<{
    principal: IdentityPrincipal;
    csrfToken: string;
  }> {
    const principal = await this.authenticate(sessionToken);
    const csrfToken = this.sessionCsrfToken(sessionToken);
    const csrfTokenHash = hashOpaqueToken(csrfToken);
    if (constantTimeTextEqual(csrfTokenHash, principal.session.csrfTokenHash)) {
      return { principal, csrfToken };
    }
    // Compatibility for sessions issued before deterministic per-session CSRF recovery. This
    // one-time replacement is never reached by newly issued sessions and therefore cannot make
    // two current tabs race with each other.
    const session = await this.repository.rotateSessionCsrf(
      hashOpaqueToken(sessionToken),
      csrfTokenHash,
      this.clock(),
    );
    if (!session) throw new IdentityError(401, 'SESSION_EXPIRED', 'Session is invalid or expired');
    return { principal: { user: principal.user, session }, csrfToken };
  }

  verifyCsrf(principal: IdentityPrincipal, csrfToken: string | undefined): void {
    if (
      !csrfToken ||
      !constantTimeTextEqual(hashOpaqueToken(csrfToken), principal.session.csrfTokenHash)
    ) {
      throw new IdentityError(403, 'CSRF_INVALID', 'CSRF token is missing or invalid');
    }
  }

  async logout(
    sessionToken: string,
    principal: IdentityPrincipal,
    context: IdentityRequestContext,
  ): Promise<void> {
    if (!(await this.repository.revokeSession(hashOpaqueToken(sessionToken), this.clock()))) {
      throw new IdentityError(401, 'SESSION_EXPIRED', 'Session is invalid or expired');
    }
    await this.audit(
      { ...context, actorUserId: principal.user.id },
      'session',
      principal.session.id,
      'succeeded',
      {},
    );
  }

  async changePassword(
    principal: IdentityPrincipal,
    currentPassword: string,
    newPassword: string,
    context: IdentityRequestContext,
  ): Promise<void> {
    const user = await this.repository.findUserById(principal.user.id);
    if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
      await this.audit(context, 'member', principal.user.id, 'denied', {
        reason: 'wrong-password',
      });
      throw new IdentityError(401, 'INVALID_CREDENTIALS', 'Current password is invalid');
    }
    const passwordHash = await hashPassword(newPassword);
    await this.repository.updatePassword(user.id, passwordHash);
    await this.repository.revokeUserSessions(user.id, this.clock());
    await this.audit({ ...context, actorUserId: user.id }, 'member', user.id, 'succeeded', {
      passwordChanged: true,
    });
  }

  async resetPassword(
    resetToken: string,
    newPassword: string,
    context: IdentityRequestContext,
  ): Promise<void> {
    await this.enforcePublicTokenRateLimit(context, 'password-reset');
    try {
      validatePassword(newPassword);
    } catch (error) {
      await this.audit(context, 'member', null, 'failed', { reason: 'invalid-new-password' });
      throw error;
    }
    const tokenHash = hashOpaqueToken(resetToken);
    if (!(await this.repository.isPasswordResetTokenActive(tokenHash, this.clock()))) {
      await this.audit(context, 'member', null, 'denied', { reason: 'invalid-reset-token' });
      throw new IdentityError(400, 'RESET_TOKEN_INVALID', 'Reset link is invalid or expired');
    }
    let passwordHash: string;
    try {
      passwordHash = await hashPassword(newPassword);
    } catch (error) {
      await this.audit(context, 'member', null, 'failed', { reason: 'password-hash-failed' });
      throw error;
    }
    const user = await this.repository.consumePasswordReset(tokenHash, passwordHash, this.clock());
    if (!user) {
      await this.audit(context, 'member', null, 'failed', { reason: 'reset-token-race' });
      throw new IdentityError(400, 'RESET_TOKEN_INVALID', 'Reset link is invalid or expired');
    }
    await this.repository.revokeUserSessions(user.id, this.clock());
    await this.audit({ ...context, actorUserId: user.id }, 'member', user.id, 'succeeded', {
      passwordReset: true,
    });
  }

  async listMembers(principal: IdentityPrincipal): Promise<PublicIdentityUser[]> {
    this.requirePermission(principal, 'member.manage');
    return (await this.repository.listUsers()).map(publicUser);
  }

  async updateMember(
    principal: IdentityPrincipal,
    memberId: string,
    input: { role?: IdentityRole; disabled?: boolean; displayName?: string },
    context: IdentityRequestContext,
  ): Promise<PublicIdentityUser> {
    this.requirePermission(principal, 'member.manage');
    const target = await this.repository.findUserById(memberId);
    if (!target) throw new IdentityError(404, 'NOT_FOUND', 'Member was not found');
    const removesAdmin =
      target.role === 'admin' &&
      ((input.role !== undefined && input.role !== 'admin') || input.disabled === true);
    if (removesAdmin && (await this.repository.countActiveAdmins()) <= 1) {
      throw new IdentityError(
        409,
        'LAST_ADMIN_REQUIRED',
        'The last active administrator cannot be disabled or demoted',
      );
    }
    const updated = await this.repository.updateUser(memberId, input);
    if (!updated) throw new IdentityError(404, 'NOT_FOUND', 'Member was not found');
    if (input.role !== undefined || input.disabled !== undefined) {
      await this.repository.revokeUserSessions(memberId, this.clock());
    }
    await this.audit(
      { ...context, actorUserId: principal.user.id },
      'member',
      memberId,
      'succeeded',
      input,
    );
    return publicUser(updated);
  }

  async createInvitation(
    principal: IdentityPrincipal,
    input: { email: string; role: IdentityRole },
    context: IdentityRequestContext,
  ): Promise<{ invitation: PublicInvitation; token: string }> {
    this.requirePermission(principal, 'member.manage');
    const email = parseEmail(input.email);
    if (await this.repository.findUserByEmail(email)) {
      throw new IdentityError(409, 'MEMBER_EXISTS', 'A member already uses this email address');
    }
    const token = issueOpaqueToken();
    const invitation = await this.repository.createInvitation({
      email,
      role: input.role,
      tokenHash: hashOpaqueToken(token),
      expiresAt: new Date(this.clock().getTime() + this.invitationTtlMs),
      createdBy: principal.user.id,
    });
    await this.audit(
      { ...context, actorUserId: principal.user.id },
      'invitation',
      invitation.id,
      'succeeded',
      { email, role: input.role },
    );
    return { invitation: publicInvitation(invitation), token };
  }

  async listInvitations(principal: IdentityPrincipal): Promise<PublicInvitation[]> {
    this.requirePermission(principal, 'member.manage');
    return (await this.repository.listInvitations()).map(publicInvitation);
  }

  async revokeInvitation(
    principal: IdentityPrincipal,
    invitationId: string,
    context: IdentityRequestContext,
  ): Promise<void> {
    this.requirePermission(principal, 'member.manage');
    if (!(await this.repository.revokeInvitation(invitationId, this.clock()))) {
      throw new IdentityError(404, 'NOT_FOUND', 'Invitation was not found or is no longer active');
    }
    await this.audit(
      { ...context, actorUserId: principal.user.id },
      'invitation',
      invitationId,
      'succeeded',
      { revoked: true },
    );
  }

  async acceptInvitation(
    input: { token: string; displayName: string; password: string },
    context: IdentityRequestContext,
  ): Promise<PublicIdentityUser> {
    await this.enforcePublicTokenRateLimit(context, 'invitation-accept');
    let displayName: string;
    try {
      displayName = requiredName(input.displayName);
      validatePassword(input.password);
    } catch (error) {
      await this.audit(context, 'invitation', null, 'failed', { reason: 'invalid-input' });
      throw error;
    }
    const tokenHash = hashOpaqueToken(input.token);
    if (!(await this.repository.isInvitationTokenActive(tokenHash, this.clock()))) {
      await this.audit(context, 'invitation', null, 'denied', {
        reason: 'invalid-invitation-token',
      });
      throw new IdentityError(400, 'INVITATION_INVALID', 'Invitation is invalid or expired');
    }
    let passwordHash: string;
    try {
      passwordHash = await hashPassword(input.password);
    } catch (error) {
      await this.audit(context, 'invitation', null, 'failed', {
        reason: 'password-hash-failed',
      });
      throw error;
    }
    const user = await this.repository.consumeInvitation({
      tokenHash,
      displayName,
      passwordHash,
      at: this.clock(),
    });
    if (!user) {
      await this.audit(context, 'invitation', null, 'failed', {
        reason: 'invitation-token-race',
      });
      throw new IdentityError(400, 'INVITATION_INVALID', 'Invitation is invalid or expired');
    }
    await this.audit({ ...context, actorUserId: user.id }, 'member', user.id, 'succeeded', {
      invitationAccepted: true,
      role: user.role,
    });
    return publicUser(user);
  }

  async createPasswordReset(
    principal: IdentityPrincipal,
    memberId: string,
    context: IdentityRequestContext,
  ): Promise<{ token: string; expiresAt: string }> {
    this.requirePermission(principal, 'member.manage');
    const user = await this.repository.findUserById(memberId);
    if (!user) throw new IdentityError(404, 'NOT_FOUND', 'Member was not found');
    const token = issueOpaqueToken();
    const expiresAt = new Date(this.clock().getTime() + this.passwordResetTtlMs);
    await this.repository.createPasswordReset({
      userId: memberId,
      tokenHash: hashOpaqueToken(token),
      expiresAt,
      createdBy: principal.user.id,
    });
    await this.audit(
      { ...context, actorUserId: principal.user.id },
      'member',
      memberId,
      'succeeded',
      { passwordResetCreated: true },
    );
    return { token, expiresAt: expiresAt.toISOString() };
  }

  async listAuditEvents(
    principal: IdentityPrincipal,
    cursor?: string,
    limit?: number,
  ): Promise<AuditPage> {
    this.requirePermission(principal, 'audit.read');
    return this.repository.listAuditEvents(cursor, limit);
  }

  requirePermission(principal: IdentityPrincipal, permission: IdentityPermission): void {
    if (!hasPermission(principal.user.role, permission)) {
      throw new IdentityError(
        403,
        'FORBIDDEN',
        'You do not have permission to perform this action',
      );
    }
  }

  async recordDenied(
    context: IdentityRequestContext,
    resourceType: string,
    resourceId: string | null,
    details: unknown,
  ): Promise<void> {
    await this.audit(context, resourceType, resourceId, 'denied', details);
  }

  private sessionCsrfToken(sessionToken: string): string {
    return hashPrivateIdentifier(`identity-csrf-v1:${sessionToken}`, this.identifierPepper);
  }

  async recordOperation(input: {
    actorUserId: string;
    operationId: string;
    resourceType: string;
    resourceId: string | null;
    result: AuditResult;
    traceId?: string;
    network?: string;
    statusCode: number;
  }): Promise<void> {
    await this.audit(
      {
        operationId: input.operationId,
        actorUserId: input.actorUserId,
        ...(input.traceId ? { traceId: input.traceId } : {}),
        ...(input.network ? { network: input.network } : {}),
      },
      input.resourceType,
      input.resourceId,
      input.result,
      { statusCode: input.statusCode },
    );
  }

  private async audit(
    context: IdentityRequestContext,
    resourceType: string,
    resourceId: string | null,
    result: AuditResult,
    details: unknown,
  ): Promise<void> {
    await this.repository.createAuditEvent({
      actorUserId: context.actorUserId ?? null,
      operationId: context.operationId,
      resourceType,
      resourceId,
      result,
      traceId: context.traceId ?? null,
      networkHash: context.network
        ? hashPrivateIdentifier(context.network, this.identifierPepper)
        : null,
      details: redactAuditDetails(details),
      occurredAt: this.clock(),
    });
  }

  private getDummyPasswordHash(): Promise<string> {
    this.dummyPasswordHash ??= hashPassword('not-a-real-password');
    return this.dummyPasswordHash;
  }

  private async enforcePublicTokenRateLimit(
    context: IdentityRequestContext,
    operation: 'invitation-accept' | 'password-reset',
  ): Promise<void> {
    const now = this.clock();
    const allowed = await this.repository.reserveFailedLoginSlot({
      emailHash: hashPrivateIdentifier(`public:${operation}`, this.identifierPepper),
      networkHash: hashPrivateIdentifier(context.network ?? 'unknown', this.identifierPepper),
      occurredAt: now,
      windowStartsAt: new Date(now.getTime() - this.publicTokenWindowMs),
      maximumFailures: this.maxPublicTokenAttempts,
    });
    if (allowed) return;
    await this.audit(
      context,
      operation === 'invitation-accept' ? 'invitation' : 'member',
      null,
      'denied',
      {
        reason: 'rate-limited',
      },
    );
    throw new IdentityError(429, 'IDENTITY_RATE_LIMITED', 'Too many attempts; try again later');
  }
}

function publicInvitation(invitation: IdentityInvitation): PublicInvitation {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    expiresAt: invitation.expiresAt,
    createdBy: invitation.createdBy,
    acceptedAt: invitation.acceptedAt,
    revokedAt: invitation.revokedAt,
    createdAt: invitation.createdAt,
  };
}

function loginEmail(value: string): {
  email: string | null;
  lookupValue: string;
  rateLimitIdentifier: string;
} {
  try {
    const email = normalizeEmail(value);
    return { email, lookupValue: email, rateLimitIdentifier: email };
  } catch {
    const normalized = value.trim().toLocaleLowerCase('en-US').slice(0, 1_024);
    return {
      email: null,
      // Deliberately exceeds the maximum accepted email length and therefore cannot collide with
      // an account created through the identity service, while still exercising the same lookup.
      lookupValue: `${'x'.repeat(321)}@invalid.invalid`,
      rateLimitIdentifier: `invalid:${normalized}`,
    };
  }
}

function parseEmail(value: string): string {
  try {
    return normalizeEmail(value);
  } catch (error) {
    throw new IdentityError(
      400,
      'VALIDATION_ERROR',
      error instanceof Error ? error.message : 'Invalid email',
    );
  }
}

function requiredName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 120)
    throw new IdentityError(400, 'VALIDATION_ERROR', 'Display name is required');
  return name;
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value;
}

export * from './security.js';
