import type {
  AuditResult,
  IdentityAuditEvent,
  IdentityInvitation,
  IdentityPasswordReset,
  IdentityPrincipal,
  IdentityRole,
  IdentitySession,
  IdentityUser,
  PublicIdentityUser,
} from '../domain/index.js';

export interface AuditPage {
  readonly items: readonly IdentityAuditEvent[];
  readonly nextCursor: string | null;
}

export interface IdentityRepository {
  migrate(): Promise<void>;
  close(): Promise<void>;
  countUsers(): Promise<number>;
  countActiveAdmins(): Promise<number>;
  createBootstrapAdmin(input: {
    email: string;
    displayName: string;
    passwordHash: string;
  }): Promise<IdentityUser | null>;
  createUser(input: {
    email: string;
    displayName: string;
    passwordHash: string;
    role: IdentityRole;
  }): Promise<IdentityUser>;
  findUserById(id: string): Promise<IdentityUser | null>;
  findUserByEmail(email: string): Promise<IdentityUser | null>;
  listUsers(): Promise<IdentityUser[]>;
  updateUser(
    id: string,
    input: { role?: IdentityRole; disabled?: boolean; displayName?: string },
  ): Promise<IdentityUser | null>;
  updatePassword(userId: string, passwordHash: string): Promise<IdentityUser | null>;
  createSession(input: {
    userId: string;
    tokenHash: string;
    csrfTokenHash: string;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
  }): Promise<IdentitySession>;
  activateSession(
    tokenHash: string,
    now: Date,
    idleExpiresAt: Date,
  ): Promise<IdentitySession | null>;
  rotateSessionCsrf(
    tokenHash: string,
    csrfTokenHash: string,
    at: Date,
  ): Promise<IdentitySession | null>;
  revokeSession(tokenHash: string, at: Date): Promise<boolean>;
  revokeUserSessions(userId: string, at: Date): Promise<number>;
  recordLoginAttempt(input: {
    emailHash: string;
    networkHash: string;
    succeeded: boolean;
    occurredAt: Date;
  }): Promise<void>;
  reserveFailedLoginSlot(input: {
    emailHash: string;
    networkHash: string;
    occurredAt: Date;
    windowStartsAt: Date;
    maximumFailures: number;
  }): Promise<boolean>;
  countRecentFailedLogins(emailHash: string, networkHash: string, since: Date): Promise<number>;
  clearLoginFailures(emailHash: string, networkHash: string): Promise<void>;
  createInvitation(input: {
    email: string;
    role: IdentityRole;
    tokenHash: string;
    expiresAt: Date;
    createdBy: string;
  }): Promise<IdentityInvitation>;
  listInvitations(): Promise<IdentityInvitation[]>;
  revokeInvitation(id: string, at: Date): Promise<boolean>;
  isInvitationTokenActive(tokenHash: string, at: Date): Promise<boolean>;
  consumeInvitation(input: {
    tokenHash: string;
    displayName: string;
    passwordHash: string;
    at: Date;
  }): Promise<IdentityUser | null>;
  createPasswordReset(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    createdBy: string;
  }): Promise<IdentityPasswordReset>;
  isPasswordResetTokenActive(tokenHash: string, at: Date): Promise<boolean>;
  consumePasswordReset(
    tokenHash: string,
    passwordHash: string,
    at: Date,
  ): Promise<IdentityUser | null>;
  createAuditEvent(input: {
    actorUserId: string | null;
    operationId: string;
    resourceType: string;
    resourceId: string | null;
    result: AuditResult;
    traceId: string | null;
    networkHash: string | null;
    details: unknown;
    occurredAt: Date;
  }): Promise<IdentityAuditEvent>;
  listAuditEvents(cursor?: string, limit?: number): Promise<AuditPage>;
}

export interface IdentityServiceContract {
  status(): Promise<{ initialized: boolean }>;
  authenticate(sessionToken: string, at?: Date): Promise<IdentityPrincipal>;
  listMembers(principal: IdentityPrincipal): Promise<PublicIdentityUser[]>;
}
