import { database } from '../../server/src/db.js';
import { migrate } from '../../server/src/migrate.js';
import { encrypt } from '../../server/src/security.js';
import { readConfig } from '../../server/src/config.js';
import { assertTestDatabase } from '../../../tooling/scripts/test-environment.js';
const config = readConfig();
const uri = assertTestDatabase(config.CLOUD_DATABASE_URL, 'e2e');
if (config.NODE_ENV === 'production')
  throw new Error('E2E seed requires isolated *_e2e_test database');
const admin = database(new URL('/postgres', uri).toString());
try {
  await admin.sql.unsafe(`create database "${uri.pathname.slice(1).replaceAll('"', '""')}"`);
} catch (error) {
  if ((error as { code: string }).code !== '42P04') throw error;
} finally {
  await admin.close();
}
await migrate(config.CLOUD_DATABASE_URL);
const db = database(config.CLOUD_DATABASE_URL);
try {
  await db.sql`truncate cloud_users,cloud_staff,cloud_models,cloud_prices,cloud_jobs,cloud_audit,cloud_rate_limits,cloud_refresh_history restart identity cascade`;
  const password = await Bun.password.hash('Test-Only-Password-2026');
  const [user] = await db.sql`insert into cloud_users default values returning id`;
  await db.sql`insert into cloud_identities(user_id,target,password_hash,verified) values (${user!.id},'user@zhiyun.test',${password},true)`;
  await db.sql`insert into cloud_staff(email,password_hash,mfa_secret,role) values ('admin@zhiyun.test',${password},${encrypt('JBSWY3DPEHPK3PXP', config.CLOUD_MFA_KEY)},'owner')`;
  console.info('Isolated cloud E2E accounts prepared');
} finally {
  await db.close();
}
