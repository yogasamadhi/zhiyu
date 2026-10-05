import { randomInt } from 'node:crypto';
import type { Database, Tx } from './db.js';
import { DomainError, requireValue, type Clock, type Config } from './config.js';
import { hash, secret, decrypt, totp } from './security.js';
import { deliver } from './messages.js';
export interface Principal {
  sessionId: string;
  userId: string | null;
  staffId: string | null;
  deviceId: string | null;
  csrf: string;
  role: string | null;
}
export class Auth {
  constructor(
    readonly db: Database,
    readonly config: Config,
    readonly clock: Clock,
  ) {}
  async session(token: string): Promise<Principal> {
    const now = this.clock.now();
    const [s] = await this.db
      .sql`select s.*, f.role, f.disabled, u.status as user_status, d.revoked_at as device_revoked from cloud_sessions s left join cloud_staff f on f.id=s.staff_id left join cloud_users u on u.id=s.user_id left join cloud_devices d on d.id=s.device_id where s.digest=${hash(token)} and s.revoked_at is null and s.expires_at>${now}`;
    if (!s || s.disabled || s.user_status === 'disabled' || s.device_revoked)
      throw new DomainError('UNAUTHENTICATED', 401);
    return {
      sessionId: s.id,
      userId: s.user_id,
      staffId: s.staff_id,
      deviceId: s.device_id,
      csrf: s.csrf,
      role: s.role,
    };
  }
  async issue(
    tx: Tx,
    userId: string | null,
    staffId: string | null,
    deviceId: string | null = null,
    family?: string,
  ) {
    const access = secret(),
      refresh = deviceId ? secret() : null,
      csrf = secret();
    const now = this.clock.now();
    const expires = new Date(
      now.getTime() + (deviceId ? 15 * 60 : staffId ? 8 * 3600 : 24 * 3600) * 1000,
    );
    const [row] =
      await tx`insert into cloud_sessions(user_id,staff_id,device_id,digest,refresh_digest,csrf,expires_at,refresh_expires_at,family) values (${userId},${staffId},${deviceId},${hash(access)},${refresh ? hash(refresh) : null},${csrf},${expires},${refresh ? new Date(now.getTime() + 30 * 86400000) : null},${family ?? crypto.randomUUID()}) returning id`;
    return {
      access,
      refresh,
      csrf,
      expiresAt: expires.toISOString(),
      sessionId: row!.id as string,
    };
  }
  async challenge(target: string, purpose: string, principal?: Principal) {
    target = target.trim().toLowerCase();
    if (!/^(?:\+?86)?1\d{10}$/.test(target) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target))
      throw new DomainError('INVALID_IDENTITY', 400);
    if (!target.includes('@')) target = '+86' + target.replace(/^\+?86/, '');
    if (purpose === 'bind' && !principal?.userId) throw new DomainError('UNAUTHENTICATED', 401);
    const now = this.clock.now(),
      code = randomInt(100000, 1000000).toString();
    const expires = new Date(now.getTime() + 600000);
    const challengeId = await this.db.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${target}))`;
      const [recent] =
        await tx`select count(*)::int as n from cloud_challenges where target=${target} and created_at>${new Date(now.getTime() - 3600000)}`;
      if (recent!.n >= 6) throw new DomainError('CHALLENGE_RATE_LIMIT', 429);
      const [row] =
        await tx`insert into cloud_challenges(target,purpose,user_id,digest,expires_at,created_at) values (${target},${purpose},${principal?.userId ?? null},${hash(code)},${expires},${now}) returning id`;
      if (this.config.CLOUD_REAL_MESSAGES !== 'true' && this.config.NODE_ENV !== 'production')
        await tx`insert into cloud_test_inbox(challenge_id,target,code,expires_at) values (${row!.id},${target},${code},${expires})`;
      return row!.id as string;
    });
    if (this.config.CLOUD_REAL_MESSAGES === 'true') await deliver(this.config, target, code);
    if (this.config.NODE_ENV === 'production' && this.config.CLOUD_REAL_MESSAGES !== 'true')
      throw new DomainError('MESSAGING_UNAVAILABLE', 503);
    return { challengeId, expiresAt: expires.toISOString() };
  }
  async verify(
    challengeId: string,
    code: string,
    password: string | undefined,
    principal?: Principal,
  ) {
    const passwordHash = password
      ? await Bun.password.hash(password, { algorithm: 'argon2id' })
      : null;
    // Commit failed attempts as well; throwing inside the transaction would roll them back.
    const result = await this.db.sql.begin(async (tx) => {
      const [c] = await tx`select * from cloud_challenges where id=${challengeId} for update`;
      if (!c || c.used_at || c.expires_at <= this.clock.now() || c.attempts >= 5)
        return { error: 'INVALID_CHALLENGE' };
      await tx`update cloud_challenges set attempts=attempts+1 where id=${challengeId}`;
      if (c.digest !== hash(code)) return { error: 'INVALID_CHALLENGE' };
      if (c.purpose === 'bind' && (!principal?.userId || c.user_id !== principal.userId))
        return { error: 'BINDING_OWNER_MISMATCH' };
      await tx`select pg_advisory_xact_lock(hashtext(${c.target}))`;
      const [identity] =
        await tx`select * from cloud_identities where target=${c.target} for update`;
      if (c.purpose === 'bind') {
        if (identity && identity.user_id !== principal!.userId)
          return { error: 'IDENTITY_ALREADY_BOUND' };
        if (!identity)
          await tx`insert into cloud_identities(user_id,target,password_hash,verified) values (${principal!.userId},${c.target},${passwordHash},true)`;
        await tx`update cloud_challenges set used_at=${this.clock.now()} where id=${challengeId}`;
        return { bound: true };
      }
      if (c.purpose === 'reset' && (!identity || !passwordHash))
        return { error: 'RESET_NOT_AVAILABLE' };
      if (c.target.includes('@') && !identity && !passwordHash)
        return { error: 'PASSWORD_REQUIRED' };
      let userId = identity?.user_id as string | undefined;
      if (!userId) {
        const [user] = await tx`insert into cloud_users default values returning id`;
        userId = user!.id as string;
        await tx`insert into cloud_identities(user_id,target,password_hash,verified) values (${userId},${c.target},${passwordHash},true)`;
      } else {
        await tx`update cloud_identities set verified=true where id=${identity!.id}`;
        if (c.purpose === 'reset') {
          await tx`update cloud_identities set password_hash=${passwordHash} where id=${identity!.id}`;
          await tx`update cloud_sessions set revoked_at=${this.clock.now()} where user_id=${userId}`;
        }
      }
      const [user] = await tx`select status from cloud_users where id=${userId}`;
      if (user!.status !== 'active') return { error: 'ACCOUNT_DISABLED' };
      await tx`update cloud_challenges set used_at=${this.clock.now()} where id=${challengeId}`;
      return this.issue(tx, userId, null);
    });
    if ('error' in result) throw new DomainError(result.error!, 400);
    return result;
  }
  async login(email: string, password: string, staff = false, token?: string) {
    const [identity] = staff
      ? await this.db.sql`select * from cloud_staff where email=${email}`
      : await this.db
          .sql`select i.*, u.status from cloud_identities i join cloud_users u on u.id=i.user_id where target=${email} and verified=true`;
    if (
      !identity?.password_hash ||
      !(await Bun.password.verify(password, identity.password_hash as string)) ||
      identity.disabled ||
      identity.status === 'disabled'
    )
      throw new DomainError('INVALID_CREDENTIALS', 401);
    return this.db.sql.begin(async (tx) => {
      if (staff) {
        const counter = token
          ? totp(
              decrypt(identity.mfa_secret as string, this.config.CLOUD_MFA_KEY),
              token,
              this.clock.now(),
            )
          : null;
        if (counter === null) throw new DomainError('MFA_REQUIRED', 401);
        const rows =
          await tx`update cloud_staff set last_totp=${counter} where id=${identity.id} and last_totp<${counter} returning id`;
        if (!rows.length) throw new DomainError('MFA_REPLAY', 401);
      }
      return this.issue(
        tx,
        staff ? null : (identity.user_id as string),
        staff ? (identity.id as string) : null,
      );
    });
  }
  async authorize(
    userId: string,
    input: { challenge: string; redirectUri: string; deviceId: string; deviceName: string },
  ) {
    const uri = new URL(input.redirectUri);
    if (
      uri.protocol !== 'http:' ||
      uri.hostname !== '127.0.0.1' ||
      uri.pathname !== '/callback' ||
      !uri.port ||
      uri.search ||
      uri.hash ||
      uri.username ||
      uri.password
    )
      throw new DomainError('INVALID_LOOPBACK', 400);
    const code = secret();
    await this.db
      .sql`insert into cloud_desktop_codes(digest,user_id,challenge,redirect_uri,device_id,device_name,expires_at) values (${hash(code)},${userId},${input.challenge},${input.redirectUri},${input.deviceId},${input.deviceName},${new Date(this.clock.now().getTime() + 120000)})`;
    return { code };
  }
  async exchange(code: string, verifier: string, redirectUri: string) {
    return this.db.sql.begin(async (tx) => {
      const c = requireValue(
        (await tx`select * from cloud_desktop_codes where digest=${hash(code)} for update`)[0],
      );
      const challenge = Buffer.from(hash(verifier), 'hex').toString('base64url');
      if (
        c.used_at ||
        c.expires_at <= this.clock.now() ||
        c.redirect_uri !== redirectUri ||
        c.challenge !== challenge
      )
        throw new DomainError('INVALID_AUTHORIZATION', 400);
      await tx`select id from cloud_users where id=${c.user_id} for no key update`;
      const [device] = await tx`select * from cloud_devices where id=${c.device_id}`;
      const deviceId =
        device && device.user_id !== c.user_id ? crypto.randomUUID() : (c.device_id as string);
      if (!device || device.user_id !== c.user_id || device.revoked_at) {
        const [n] =
          await tx`select count(*)::int as n from cloud_devices where user_id=${c.user_id} and revoked_at is null`;
        if (n!.n >= 2) throw new DomainError('DEVICE_LIMIT', 409);
        if (device && device.user_id === c.user_id) {
          await tx`update cloud_sessions set revoked_at=${this.clock.now()} where device_id=${deviceId}`;
          await tx`update cloud_devices set revoked_at=null,name=${c.device_name} where id=${deviceId}`;
        } else
          await tx`insert into cloud_devices(id,user_id,name) values (${deviceId},${c.user_id},${c.device_name})`;
      }
      await tx`update cloud_desktop_codes set used_at=${this.clock.now()} where id=${c.id}`;
      return { ...(await this.issue(tx, c.user_id as string, null, deviceId)), deviceId };
    });
  }
  async refresh(token: string) {
    const result = await this.db.sql.begin(async (tx) => {
      const [s] =
        await tx`select s.*, d.revoked_at as device_revoked, u.status as user_status from cloud_sessions s join cloud_devices d on d.id=s.device_id join cloud_users u on u.id=s.user_id where refresh_digest=${hash(token)} for update of s`;
      if (!s) {
        const [old] =
          await tx`select family from cloud_refresh_history where digest=${hash(token)}`;
        if (old)
          await tx`update cloud_sessions set revoked_at=${this.clock.now()} where family=${old.family}`;
        return null;
      }
      if (
        s.revoked_at ||
        s.device_revoked ||
        s.user_status !== 'active' ||
        s.refresh_expires_at <= this.clock.now()
      )
        return null;
      await tx`insert into cloud_refresh_history(digest,family) values (${hash(token)},${s.family})`;
      await tx`update cloud_sessions set revoked_at=${this.clock.now()}, refresh_digest=null where id=${s.id}`;
      return this.issue(tx, s.user_id as string, null, s.device_id as string, s.family as string);
    });
    if (!result) throw new DomainError('INVALID_REFRESH', 401);
    return result;
  }
}
