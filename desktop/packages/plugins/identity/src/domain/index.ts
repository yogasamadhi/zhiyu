import { createHash } from 'node:crypto';

export const identityRoles = ['admin', 'editor', 'viewer'] as const;
export type IdentityRole = (typeof identityRoles)[number];

export const identityPermissions = [
  'workspace.read',
  'workspace.manage',
  'task.write',
  'run.execute',
  'analysis.write',
  'output.bind',
  'output.manage',
  'member.manage',
  'audit.read',
] as const;
export type IdentityPermission = (typeof identityPermissions)[number];

export const rolePermissions: Readonly<Record<IdentityRole, readonly IdentityPermission[]>> = {
  admin: identityPermissions,
  editor: ['workspace.read', 'task.write', 'run.execute', 'analysis.write', 'output.bind'],
  viewer: ['workspace.read'],
};

export function hasPermission(role: IdentityRole, permission: IdentityPermission): boolean {
  return rolePermissions[role].includes(permission);
}

export function normalizeEmail(value: string): string {
  const email = value.trim().toLocaleLowerCase('en-US');
  if (email.length < 3 || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new Error('A valid email address is required');
  }
  return email;
}

export interface IdentityUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly role: IdentityRole;
  readonly disabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type PublicIdentityUser = Omit<IdentityUser, 'passwordHash'>;

export function publicUser(user: IdentityUser): PublicIdentityUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    disabled: user.disabled,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export interface IdentitySession {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly csrfTokenHash: string;
  readonly lastSeenAt: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export interface IdentityInvitation {
  readonly id: string;
  readonly email: string;
  readonly role: IdentityRole;
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly createdBy: string;
  readonly acceptedAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export interface IdentityPasswordReset {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly createdBy: string;
  readonly consumedAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export type AuditResult = 'succeeded' | 'failed' | 'denied';

export interface IdentityAuditEvent {
  readonly id: string;
  readonly actorUserId: string | null;
  readonly operationId: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly result: AuditResult;
  readonly traceId: string | null;
  readonly networkHash: string | null;
  readonly details: unknown;
  readonly occurredAt: string;
}

export interface IdentityPrincipal {
  readonly user: PublicIdentityUser;
  readonly session: IdentitySession;
}

const SENSITIVE_KEY =
  /(?:password|passphrase|token|secret|authorization|cookie|credential|private[_-]?key|service[_-]?account|access[_-]?key|csrf)/iu;

/** Makes audit metadata bounded and safe before it reaches persistence. */
export function redactAuditDetails(value: unknown): unknown {
  return redact(value, new WeakSet<object>(), 0);
}

function redact(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, 2_048);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return String(value);
  if (depth >= 6) return '[TRUNCATED]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, seen, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value).slice(0, 100)) {
    result[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(nested, seen, depth + 1);
  }
  return result;
}

export function hashPrivateIdentifier(value: string, pepper: string): string {
  return createHash('sha256').update(pepper).update('\0').update(value).digest('hex');
}
