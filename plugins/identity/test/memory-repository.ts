import { randomUUID } from 'node:crypto';
import type { AuditPage, IdentityRepository } from '../src/contracts/index.js';
import type {
  AuditResult,
  IdentityAuditEvent,
  IdentityInvitation,
  IdentityPasswordReset,
  IdentityRole,
  IdentitySession,
  IdentityUser,
} from '../src/domain/index.js';

interface LoginAttempt {
  emailHash: string;
  networkHash: string;
  succeeded: boolean;
  occurredAt: Date;
}

export class MemoryIdentityRepository implements IdentityRepository {
  readonly users: IdentityUser[] = [];
  readonly sessions: IdentitySession[] = [];
  readonly invitations: IdentityInvitation[] = [];
  readonly resets: IdentityPasswordReset[] = [];
  readonly audits: IdentityAuditEvent[] = [];
  readonly loginAttempts: LoginAttempt[] = [];

  async migrate(): Promise<void> {}
  async close(): Promise<void> {}

  async countUsers(): Promise<number> {
    return this.users.length;
  }

  async countActiveAdmins(): Promise<number> {
    return this.users.filter((user) => user.role === 'admin' && !user.disabled).length;
  }

  async createBootstrapAdmin(input: {
    email: string;
    displayName: string;
    passwordHash: string;
  }): Promise<IdentityUser | null> {
    if (this.users.length > 0) return null;
    return this.createUser({ ...input, role: 'admin' });
  }

  async createUser(input: {
    email: string;
    displayName: string;
    passwordHash: string;
    role: IdentityRole;
  }): Promise<IdentityUser> {
    if (this.users.some((user) => user.email === input.email)) throw new Error('duplicate email');
    const timestamp = new Date().toISOString();
    const user: IdentityUser = {
      id: randomUUID(),
      ...input,
      disabled: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.users.push(user);
    return user;
  }

  async findUserById(id: string): Promise<IdentityUser | null> {
    return this.users.find((user) => user.id === id) ?? null;
  }

  async findUserByEmail(email: string): Promise<IdentityUser | null> {
    return this.users.find((user) => user.email === email) ?? null;
  }

  async listUsers(): Promise<IdentityUser[]> {
    return [...this.users];
  }

  async updateUser(
    id: string,
    input: { role?: IdentityRole; disabled?: boolean; displayName?: string },
  ): Promise<IdentityUser | null> {
    const index = this.users.findIndex((user) => user.id === id);
    const current = this.users[index];
    if (!current) return null;
    const updated: IdentityUser = {
      ...current,
      ...input,
      updatedAt: new Date().toISOString(),
    };
    this.users[index] = updated;
    return updated;
  }

  async updatePassword(userId: string, passwordHash: string): Promise<IdentityUser | null> {
    const index = this.users.findIndex((user) => user.id === userId);
    const current = this.users[index];
    if (!current) return null;
    const updated = { ...current, passwordHash, updatedAt: new Date().toISOString() };
    this.users[index] = updated;
    return updated;
  }

  async createSession(input: {
    userId: string;
    tokenHash: string;
    csrfTokenHash: string;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
  }): Promise<IdentitySession> {
    const timestamp = new Date().toISOString();
    const session: IdentitySession = {
      id: randomUUID(),
      ...input,
      idleExpiresAt: input.idleExpiresAt.toISOString(),
      absoluteExpiresAt: input.absoluteExpiresAt.toISOString(),
      lastSeenAt: timestamp,
      revokedAt: null,
      createdAt: timestamp,
    };
    this.sessions.push(session);
    return session;
  }

  async activateSession(
    tokenHash: string,
    now: Date,
    idleExpiresAt: Date,
  ): Promise<IdentitySession | null> {
    const index = this.sessions.findIndex((session) => session.tokenHash === tokenHash);
    const current = this.sessions[index];
    if (
      !current ||
      current.revokedAt ||
      new Date(current.idleExpiresAt) <= now ||
      new Date(current.absoluteExpiresAt) <= now
    )
      return null;
    const updated: IdentitySession = {
      ...current,
      lastSeenAt: now.toISOString(),
      idleExpiresAt: new Date(
        Math.min(idleExpiresAt.getTime(), new Date(current.absoluteExpiresAt).getTime()),
      ).toISOString(),
    };
    this.sessions[index] = updated;
    return updated;
  }

  async rotateSessionCsrf(
    tokenHash: string,
    csrfTokenHash: string,
    at: Date,
  ): Promise<IdentitySession | null> {
    const index = this.sessions.findIndex((session) => session.tokenHash === tokenHash);
    const current = this.sessions[index];
    if (
      !current ||
      current.revokedAt ||
      new Date(current.idleExpiresAt) <= at ||
      new Date(current.absoluteExpiresAt) <= at
    ) {
      return null;
    }
    const updated = { ...current, csrfTokenHash };
    this.sessions[index] = updated;
    return updated;
  }

  async revokeSession(tokenHash: string, at: Date): Promise<boolean> {
    const index = this.sessions.findIndex(
      (session) => session.tokenHash === tokenHash && !session.revokedAt,
    );
    const current = this.sessions[index];
    if (!current) return false;
    this.sessions[index] = { ...current, revokedAt: at.toISOString() };
    return true;
  }

  async revokeUserSessions(userId: string, at: Date): Promise<number> {
    let count = 0;
    for (let index = 0; index < this.sessions.length; index += 1) {
      const current = this.sessions[index];
      if (current?.userId === userId && !current.revokedAt) {
        this.sessions[index] = { ...current, revokedAt: at.toISOString() };
        count += 1;
      }
    }
    return count;
  }

  async recordLoginAttempt(input: LoginAttempt): Promise<void> {
    this.loginAttempts.push(input);
  }

  async reserveFailedLoginSlot(input: {
    emailHash: string;
    networkHash: string;
    occurredAt: Date;
    windowStartsAt: Date;
    maximumFailures: number;
  }): Promise<boolean> {
    for (let index = this.loginAttempts.length - 1; index >= 0; index -= 1) {
      if (this.loginAttempts[index]!.occurredAt < input.windowStartsAt) {
        this.loginAttempts.splice(index, 1);
      }
    }
    const failures = this.loginAttempts.filter(
      (attempt) =>
        attempt.emailHash === input.emailHash &&
        attempt.networkHash === input.networkHash &&
        !attempt.succeeded,
    ).length;
    if (failures >= input.maximumFailures) return false;
    this.loginAttempts.push({
      emailHash: input.emailHash,
      networkHash: input.networkHash,
      succeeded: false,
      occurredAt: input.occurredAt,
    });
    return true;
  }

  async countRecentFailedLogins(
    emailHash: string,
    networkHash: string,
    since: Date,
  ): Promise<number> {
    return this.loginAttempts.filter(
      (attempt) =>
        attempt.emailHash === emailHash &&
        attempt.networkHash === networkHash &&
        !attempt.succeeded &&
        attempt.occurredAt >= since,
    ).length;
  }

  async clearLoginFailures(emailHash: string, networkHash: string): Promise<void> {
    for (let index = this.loginAttempts.length - 1; index >= 0; index -= 1) {
      const attempt = this.loginAttempts[index];
      if (
        attempt?.emailHash === emailHash &&
        attempt.networkHash === networkHash &&
        !attempt.succeeded
      ) {
        this.loginAttempts.splice(index, 1);
      }
    }
  }

  async createInvitation(input: {
    email: string;
    role: IdentityRole;
    tokenHash: string;
    expiresAt: Date;
    createdBy: string;
  }): Promise<IdentityInvitation> {
    const now = new Date().toISOString();
    for (let index = 0; index < this.invitations.length; index += 1) {
      const current = this.invitations[index];
      if (current?.email === input.email && !current.acceptedAt && !current.revokedAt) {
        this.invitations[index] = { ...current, revokedAt: now };
      }
    }
    const invitation: IdentityInvitation = {
      id: randomUUID(),
      ...input,
      expiresAt: input.expiresAt.toISOString(),
      acceptedAt: null,
      revokedAt: null,
      createdAt: now,
    };
    this.invitations.push(invitation);
    return invitation;
  }

  async listInvitations(): Promise<IdentityInvitation[]> {
    return [...this.invitations];
  }

  async revokeInvitation(id: string, at: Date): Promise<boolean> {
    const index = this.invitations.findIndex(
      (invitation) => invitation.id === id && !invitation.acceptedAt && !invitation.revokedAt,
    );
    const current = this.invitations[index];
    if (!current) return false;
    this.invitations[index] = { ...current, revokedAt: at.toISOString() };
    return true;
  }

  async isInvitationTokenActive(tokenHash: string, at: Date): Promise<boolean> {
    return this.invitations.some(
      (invitation) =>
        invitation.tokenHash === tokenHash &&
        !invitation.acceptedAt &&
        !invitation.revokedAt &&
        new Date(invitation.expiresAt) > at,
    );
  }

  async consumeInvitation(input: {
    tokenHash: string;
    displayName: string;
    passwordHash: string;
    at: Date;
  }): Promise<IdentityUser | null> {
    const index = this.invitations.findIndex(
      (invitation) =>
        invitation.tokenHash === input.tokenHash &&
        !invitation.acceptedAt &&
        !invitation.revokedAt &&
        new Date(invitation.expiresAt) > input.at,
    );
    const invitation = this.invitations[index];
    if (!invitation || this.users.some((user) => user.email === invitation.email)) return null;
    const user = await this.createUser({
      email: invitation.email,
      displayName: input.displayName,
      passwordHash: input.passwordHash,
      role: invitation.role,
    });
    this.invitations[index] = { ...invitation, acceptedAt: input.at.toISOString() };
    return user;
  }

  async createPasswordReset(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    createdBy: string;
  }): Promise<IdentityPasswordReset> {
    const now = new Date().toISOString();
    for (let index = 0; index < this.resets.length; index += 1) {
      const current = this.resets[index];
      if (current?.userId === input.userId && !current.consumedAt && !current.revokedAt) {
        this.resets[index] = { ...current, revokedAt: now };
      }
    }
    const reset: IdentityPasswordReset = {
      id: randomUUID(),
      ...input,
      expiresAt: input.expiresAt.toISOString(),
      consumedAt: null,
      revokedAt: null,
      createdAt: now,
    };
    this.resets.push(reset);
    return reset;
  }

  async isPasswordResetTokenActive(tokenHash: string, at: Date): Promise<boolean> {
    return this.resets.some(
      (reset) =>
        reset.tokenHash === tokenHash &&
        !reset.consumedAt &&
        !reset.revokedAt &&
        new Date(reset.expiresAt) > at,
    );
  }

  async consumePasswordReset(
    tokenHash: string,
    passwordHash: string,
    at: Date,
  ): Promise<IdentityUser | null> {
    const index = this.resets.findIndex(
      (reset) =>
        reset.tokenHash === tokenHash &&
        !reset.consumedAt &&
        !reset.revokedAt &&
        new Date(reset.expiresAt) > at,
    );
    const reset = this.resets[index];
    if (!reset) return null;
    const user = await this.updatePassword(reset.userId, passwordHash);
    if (!user) return null;
    this.resets[index] = { ...reset, consumedAt: at.toISOString() };
    return user;
  }

  async createAuditEvent(input: {
    actorUserId: string | null;
    operationId: string;
    resourceType: string;
    resourceId: string | null;
    result: AuditResult;
    traceId: string | null;
    networkHash: string | null;
    details: unknown;
    occurredAt: Date;
  }): Promise<IdentityAuditEvent> {
    const event: IdentityAuditEvent = {
      ...input,
      id: randomUUID(),
      occurredAt: input.occurredAt.toISOString(),
    };
    this.audits.push(event);
    return event;
  }

  async listAuditEvents(_cursor?: string, limit = 100): Promise<AuditPage> {
    return { items: this.audits.slice(-limit).reverse(), nextCursor: null };
  }
}
