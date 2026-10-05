import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { AuditPage, IdentityRepository } from '../../contracts/index.js';
import type {
  AuditResult,
  IdentityAuditEvent,
  IdentityInvitation,
  IdentityPasswordReset,
  IdentityRole,
  IdentitySession,
  IdentityUser,
} from '../../domain/index.js';
import { identitySqliteMigration001 } from '../../migrations/sqlite/index.js';

type SqlRow = Record<string, unknown>;
const MIGRATION_ID = '001-initial';

export class SqliteIdentityRepository implements IdentityRepository {
  private readonly sqlite: Database.Database;

  constructor(filePath: string) {
    this.sqlite = new Database(filePath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
  }

  private query = (parts: TemplateStringsArray, ...values: unknown[]): SqlRow[] => {
    const bindings = values.map((value) => {
      if (value instanceof Date) return value.toISOString();
      if (typeof value === 'boolean') return Number(value);
      if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'bigint' ||
        Buffer.isBuffer(value)
      )
        return value;
      throw new TypeError('Unsupported SQLite binding');
    });
    const statement = this.sqlite.prepare(parts.join('?'));
    if (statement.reader) return statement.all(...bindings) as SqlRow[];
    statement.run(...bindings);
    return [];
  };

  async migrate(): Promise<void> {
    const checksum = sha256(identitySqliteMigration001);
    const rows = this.query`
      SELECT checksum FROM plugin_migrations
      WHERE plugin_id='identity' AND migration_id=${MIGRATION_ID}
    `;
    if (rows[0]) {
      if (rows[0].checksum !== checksum) {
        throw new Error('Migration checksum mismatch for identity:001-initial');
      }
      return;
    }
    const started = performance.now();
    this.sqlite
      .transaction(() => {
        this.sqlite.exec(identitySqliteMigration001);
        void this.query`
        INSERT INTO plugin_migrations(
          plugin_id,migration_id,plugin_version,checksum,executed_at,duration_ms,result
        ) VALUES (
          'identity',${MIGRATION_ID},'1.0.0',${checksum},${new Date()},
          ${Math.max(0, Math.round(performance.now() - started))},'succeeded'
        )
      `;
      })
      .immediate();
  }

  async close(): Promise<void> {
    if (this.sqlite.open) this.sqlite.close();
  }

  async countUsers(): Promise<number> {
    const rows = this.query`SELECT COUNT(*) AS count FROM identity_users`;
    return Number(rows[0]?.count ?? 0);
  }

  async countActiveAdmins(): Promise<number> {
    const rows = this.query`
      SELECT COUNT(*) AS count FROM identity_users
      WHERE role='admin' AND disabled=FALSE
    `;
    return Number(rows[0]?.count ?? 0);
  }

  async createBootstrapAdmin(input: {
    email: string;
    displayName: string;
    passwordHash: string;
  }): Promise<IdentityUser | null> {
    return this.sqlite
      .transaction(() => {
        const counts = this.query`SELECT COUNT(*) AS count FROM identity_users`;
        if (Number(counts[0]?.count ?? 0) > 0) return null;
        const timestamp = new Date();
        const rows = this.query`
        INSERT INTO identity_users(
          id,email,display_name,password_hash,role,disabled,created_at,updated_at
        ) VALUES (
          ${randomUUID()},${input.email},${input.displayName},${input.passwordHash},'admin',
          FALSE,${timestamp},${timestamp}
        ) RETURNING *
      `;
        return userRow(rows[0] as SqlRow);
      })
      .immediate();
  }

  async createUser(input: {
    email: string;
    displayName: string;
    passwordHash: string;
    role: IdentityRole;
  }): Promise<IdentityUser> {
    const timestamp = new Date();
    const rows = this.query`
      INSERT INTO identity_users(
        id,email,display_name,password_hash,role,disabled,created_at,updated_at
      ) VALUES (
        ${randomUUID()},${input.email},${input.displayName},${input.passwordHash},${input.role},
        FALSE,${timestamp},${timestamp}
      ) RETURNING *
    `;
    return userRow(rows[0] as SqlRow);
  }

  async findUserById(id: string): Promise<IdentityUser | null> {
    const rows = this.query`SELECT * FROM identity_users WHERE id=${id}`;
    return rows[0] ? userRow(rows[0] as SqlRow) : null;
  }

  async findUserByEmail(email: string): Promise<IdentityUser | null> {
    const rows = this.query`SELECT * FROM identity_users WHERE email=${email}`;
    return rows[0] ? userRow(rows[0] as SqlRow) : null;
  }

  async listUsers(): Promise<IdentityUser[]> {
    const rows = this.query`SELECT * FROM identity_users ORDER BY created_at,id`;
    return rows.map((row) => userRow(row as SqlRow));
  }

  async updateUser(
    id: string,
    input: { role?: IdentityRole; disabled?: boolean; displayName?: string },
  ): Promise<IdentityUser | null> {
    return this.sqlite
      .transaction(() => {
        const selected = this.query`SELECT * FROM identity_users WHERE id=${id}`;
        const current = selected[0] as SqlRow | undefined;
        if (!current) return null;
        const removesActiveAdmin =
          current.role === 'admin' &&
          !current.disabled &&
          ((input.role !== undefined && input.role !== 'admin') || input.disabled === true);
        if (removesActiveAdmin) {
          const counts = this.query`
          SELECT COUNT(*) AS count FROM identity_users
          WHERE role='admin' AND disabled=FALSE
        `;
          if (Number(counts[0]?.count ?? 0) <= 1) {
            throw new Error('The last active administrator cannot be disabled or demoted');
          }
        }
        const rows = this.query`
        UPDATE identity_users SET
          role=${input.role ?? String(current.role)},
          disabled=${input.disabled ?? Boolean(current.disabled)},
          display_name=${input.displayName ?? String(current.display_name)},
          updated_at=${new Date()}
        WHERE id=${id} RETURNING *
      `;
        return userRow(rows[0] as SqlRow);
      })
      .immediate();
  }

  async updatePassword(userId: string, passwordHash: string): Promise<IdentityUser | null> {
    const rows = this.query`
      UPDATE identity_users SET password_hash=${passwordHash},updated_at=${new Date()}
      WHERE id=${userId} RETURNING *
    `;
    return rows[0] ? userRow(rows[0] as SqlRow) : null;
  }

  async createSession(input: {
    userId: string;
    tokenHash: string;
    csrfTokenHash: string;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
  }): Promise<IdentitySession> {
    const timestamp = new Date();
    const rows = this.query`
      INSERT INTO identity_sessions(
        id,user_id,token_hash,csrf_token_hash,last_seen_at,idle_expires_at,
        absolute_expires_at,revoked_at,created_at
      ) VALUES (
        ${randomUUID()},${input.userId},${input.tokenHash},${input.csrfTokenHash},${timestamp},
        ${input.idleExpiresAt},${input.absoluteExpiresAt},NULL,${timestamp}
      ) RETURNING *
    `;
    return sessionRow(rows[0] as SqlRow);
  }

  async activateSession(
    tokenHash: string,
    now: Date,
    idleExpiresAt: Date,
  ): Promise<IdentitySession | null> {
    const rows = this.query`
      UPDATE identity_sessions SET
        last_seen_at=${now},
        idle_expires_at=MIN(${idleExpiresAt},absolute_expires_at)
      WHERE token_hash=${tokenHash}
        AND revoked_at IS NULL
        AND idle_expires_at>${now}
        AND absolute_expires_at>${now}
      RETURNING *
    `;
    return rows[0] ? sessionRow(rows[0] as SqlRow) : null;
  }

  async rotateSessionCsrf(
    tokenHash: string,
    csrfTokenHash: string,
    at: Date,
  ): Promise<IdentitySession | null> {
    const rows = this.query`
      UPDATE identity_sessions SET csrf_token_hash=${csrfTokenHash}
      WHERE token_hash=${tokenHash}
        AND revoked_at IS NULL
        AND idle_expires_at>${at}
        AND absolute_expires_at>${at}
      RETURNING *
    `;
    return rows[0] ? sessionRow(rows[0] as SqlRow) : null;
  }

  async revokeSession(tokenHash: string, at: Date): Promise<boolean> {
    const rows = this.query`
      UPDATE identity_sessions SET revoked_at=${at}
      WHERE token_hash=${tokenHash} AND revoked_at IS NULL RETURNING id
    `;
    return rows.length > 0;
  }

  async revokeUserSessions(userId: string, at: Date): Promise<number> {
    const rows = this.query`
      UPDATE identity_sessions SET revoked_at=${at}
      WHERE user_id=${userId} AND revoked_at IS NULL RETURNING id
    `;
    return rows.length;
  }

  async recordLoginAttempt(input: {
    emailHash: string;
    networkHash: string;
    succeeded: boolean;
    occurredAt: Date;
  }): Promise<void> {
    void this.query`
      INSERT INTO identity_login_attempts(id,email_hash,network_hash,succeeded,occurred_at)
      VALUES (${randomUUID()},${input.emailHash},${input.networkHash},${input.succeeded},${input.occurredAt})
    `;
  }

  async reserveFailedLoginSlot(input: {
    emailHash: string;
    networkHash: string;
    occurredAt: Date;
    windowStartsAt: Date;
    maximumFailures: number;
  }): Promise<boolean> {
    return this.sqlite
      .transaction(() => {
        void this.query`
        DELETE FROM identity_login_attempts WHERE occurred_at<${input.windowStartsAt}
      `;
        const rows = this.query`
        SELECT COUNT(*) AS count FROM identity_login_attempts
        WHERE email_hash=${input.emailHash} AND network_hash=${input.networkHash}
          AND succeeded=FALSE AND occurred_at>=${input.windowStartsAt}
      `;
        if (Number(rows[0]?.count ?? 0) >= input.maximumFailures) return false;
        void this.query`
        INSERT INTO identity_login_attempts(id,email_hash,network_hash,succeeded,occurred_at)
        VALUES (
          ${randomUUID()},${input.emailHash},${input.networkHash},FALSE,${input.occurredAt}
        )
      `;
        return true;
      })
      .immediate();
  }

  async countRecentFailedLogins(
    emailHash: string,
    networkHash: string,
    since: Date,
  ): Promise<number> {
    const rows = this.query`
      SELECT COUNT(*) AS count FROM identity_login_attempts
      WHERE email_hash=${emailHash} AND network_hash=${networkHash}
        AND succeeded=FALSE AND occurred_at>=${since}
    `;
    return Number(rows[0]?.count ?? 0);
  }

  async clearLoginFailures(emailHash: string, networkHash: string): Promise<void> {
    void this.query`
      DELETE FROM identity_login_attempts
      WHERE email_hash=${emailHash} AND network_hash=${networkHash} AND succeeded=FALSE
    `;
  }

  async createInvitation(input: {
    email: string;
    role: IdentityRole;
    tokenHash: string;
    expiresAt: Date;
    createdBy: string;
  }): Promise<IdentityInvitation> {
    return this.sqlite
      .transaction(() => {
        void this.query`
        UPDATE identity_invitations SET revoked_at=${new Date()}
        WHERE email=${input.email} AND accepted_at IS NULL AND revoked_at IS NULL
      `;
        const timestamp = new Date();
        const rows = this.query`
        INSERT INTO identity_invitations(
          id,email,role,token_hash,expires_at,created_by,accepted_at,revoked_at,created_at
        ) VALUES (
          ${randomUUID()},${input.email},${input.role},${input.tokenHash},${input.expiresAt},
          ${input.createdBy},NULL,NULL,${timestamp}
        ) RETURNING *
      `;
        return invitationRow(rows[0] as SqlRow);
      })
      .immediate();
  }

  async listInvitations(): Promise<IdentityInvitation[]> {
    const rows = this.query`SELECT * FROM identity_invitations ORDER BY created_at DESC,id DESC`;
    return rows.map((row) => invitationRow(row as SqlRow));
  }

  async revokeInvitation(id: string, at: Date): Promise<boolean> {
    const rows = this.query`
      UPDATE identity_invitations SET revoked_at=${at}
      WHERE id=${id} AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id
    `;
    return rows.length > 0;
  }

  async isInvitationTokenActive(tokenHash: string, at: Date): Promise<boolean> {
    const rows = this.query`
      SELECT id FROM identity_invitations
      WHERE token_hash=${tokenHash} AND accepted_at IS NULL AND revoked_at IS NULL
        AND expires_at>${at}
      LIMIT 1
    `;
    return rows.length > 0;
  }

  async consumeInvitation(input: {
    tokenHash: string;
    displayName: string;
    passwordHash: string;
    at: Date;
  }): Promise<IdentityUser | null> {
    return this.sqlite
      .transaction(() => {
        const selected = this.query`
        SELECT * FROM identity_invitations
        WHERE token_hash=${input.tokenHash}
      `;
        const invitation = selected[0] as SqlRow | undefined;
        if (
          !invitation ||
          invitation.accepted_at ||
          invitation.revoked_at ||
          new Date(String(invitation.expires_at)) <= input.at
        )
          return null;
        const users = this.query`
        INSERT INTO identity_users(
          id,email,display_name,password_hash,role,disabled,created_at,updated_at
        ) VALUES (
          ${randomUUID()},${String(invitation.email)},${input.displayName},${input.passwordHash},
          ${String(invitation.role)},FALSE,${input.at},${input.at}
        ) ON CONFLICT(email) DO NOTHING RETURNING *
      `;
        if (!users[0]) return null;
        void this.query`
        UPDATE identity_invitations SET accepted_at=${input.at}
        WHERE id=${String(invitation.id)}
      `;
        return userRow(users[0] as SqlRow);
      })
      .immediate();
  }

  async createPasswordReset(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    createdBy: string;
  }): Promise<IdentityPasswordReset> {
    return this.sqlite
      .transaction(() => {
        const timestamp = new Date();
        void this.query`
        UPDATE identity_password_reset_tokens SET revoked_at=${timestamp}
        WHERE user_id=${input.userId} AND consumed_at IS NULL AND revoked_at IS NULL
      `;
        const rows = this.query`
        INSERT INTO identity_password_reset_tokens(
          id,user_id,token_hash,expires_at,created_by,consumed_at,revoked_at,created_at
        ) VALUES (
          ${randomUUID()},${input.userId},${input.tokenHash},${input.expiresAt},
          ${input.createdBy},NULL,NULL,${timestamp}
        ) RETURNING *
      `;
        return resetRow(rows[0] as SqlRow);
      })
      .immediate();
  }

  async isPasswordResetTokenActive(tokenHash: string, at: Date): Promise<boolean> {
    const rows = this.query`
      SELECT id FROM identity_password_reset_tokens
      WHERE token_hash=${tokenHash} AND consumed_at IS NULL AND revoked_at IS NULL
        AND expires_at>${at}
      LIMIT 1
    `;
    return rows.length > 0;
  }

  async consumePasswordReset(
    tokenHash: string,
    passwordHash: string,
    at: Date,
  ): Promise<IdentityUser | null> {
    return this.sqlite
      .transaction(() => {
        const selected = this.query`
        SELECT * FROM identity_password_reset_tokens
        WHERE token_hash=${tokenHash}
      `;
        const reset = selected[0] as SqlRow | undefined;
        if (
          !reset ||
          reset.consumed_at ||
          reset.revoked_at ||
          new Date(String(reset.expires_at)) <= at
        )
          return null;
        const users = this.query`
        UPDATE identity_users SET password_hash=${passwordHash},updated_at=${at}
        WHERE id=${String(reset.user_id)} RETURNING *
      `;
        if (!users[0]) return null;
        void this.query`
        UPDATE identity_password_reset_tokens SET consumed_at=${at}
        WHERE id=${String(reset.id)}
      `;
        return userRow(users[0] as SqlRow);
      })
      .immediate();
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
    const rows = this.query`
      INSERT INTO identity_audit_events(
        id,actor_user_id,operation_id,resource_type,resource_id,result,trace_id,
        network_hash,details,occurred_at
      ) VALUES (
        ${randomUUID()},${input.actorUserId},${input.operationId},${input.resourceType},
        ${input.resourceId},${input.result},${input.traceId},${input.networkHash},
        ${JSON.stringify(input.details)},${input.occurredAt}
      ) RETURNING *
    `;
    return auditRow(rows[0] as SqlRow);
  }

  async listAuditEvents(cursor?: string, limit = 100): Promise<AuditPage> {
    const pageSize = Math.min(Math.max(limit, 1), 500);
    const decoded = cursor ? decodeCursor(cursor) : null;
    const rows = decoded
      ? this.query`
          SELECT * FROM identity_audit_events
          WHERE occurred_at<${new Date(decoded.occurredAt)}
             OR (occurred_at=${new Date(decoded.occurredAt)} AND id<${decoded.id})
          ORDER BY occurred_at DESC,id DESC LIMIT ${pageSize + 1}
        `
      : this.query`
          SELECT * FROM identity_audit_events
          ORDER BY occurred_at DESC,id DESC LIMIT ${pageSize + 1}
        `;
    const items = rows.slice(0, pageSize).map((row) => auditRow(row as SqlRow));
    return {
      items,
      nextCursor: rows.length > pageSize ? encodeCursor(items.at(-1)!) : null,
    };
  }
}

function userRow(row: SqlRow): IdentityUser {
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    passwordHash: String(row.password_hash),
    role: row.role as IdentityRole,
    disabled: Boolean(row.disabled),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function sessionRow(row: SqlRow): IdentitySession {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    tokenHash: String(row.token_hash),
    csrfTokenHash: String(row.csrf_token_hash),
    lastSeenAt: iso(row.last_seen_at),
    idleExpiresAt: iso(row.idle_expires_at),
    absoluteExpiresAt: iso(row.absolute_expires_at),
    revokedAt: nullableIso(row.revoked_at),
    createdAt: iso(row.created_at),
  };
}

function invitationRow(row: SqlRow): IdentityInvitation {
  return {
    id: String(row.id),
    email: String(row.email),
    role: row.role as IdentityRole,
    tokenHash: String(row.token_hash),
    expiresAt: iso(row.expires_at),
    createdBy: String(row.created_by),
    acceptedAt: nullableIso(row.accepted_at),
    revokedAt: nullableIso(row.revoked_at),
    createdAt: iso(row.created_at),
  };
}

function resetRow(row: SqlRow): IdentityPasswordReset {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    tokenHash: String(row.token_hash),
    expiresAt: iso(row.expires_at),
    createdBy: String(row.created_by),
    consumedAt: nullableIso(row.consumed_at),
    revokedAt: nullableIso(row.revoked_at),
    createdAt: iso(row.created_at),
  };
}

function auditRow(row: SqlRow): IdentityAuditEvent {
  return {
    id: String(row.id),
    actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
    operationId: String(row.operation_id),
    resourceType: String(row.resource_type),
    resourceId: row.resource_id ? String(row.resource_id) : null,
    result: row.result as AuditResult,
    traceId: row.trace_id ? String(row.trace_id) : null,
    networkHash: row.network_hash ? String(row.network_hash) : null,
    details: JSON.parse(String(row.details)),
    occurredAt: iso(row.occurred_at),
  };
}

function encodeCursor(event: IdentityAuditEvent): string {
  return Buffer.from(JSON.stringify({ occurredAt: event.occurredAt, id: event.id })).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): { occurredAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    if (typeof parsed.occurredAt !== 'string' || typeof parsed.id !== 'string') throw new Error();
    return { occurredAt: parsed.occurredAt, id: parsed.id };
  } catch {
    throw new Error('Invalid audit cursor');
  }
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
