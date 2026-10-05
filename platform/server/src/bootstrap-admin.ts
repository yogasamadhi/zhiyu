import * as OTPAuth from 'otpauth';
import { database } from './db.js';
import { readConfig } from './config.js';
import { encrypt } from './security.js';
import { email, password } from '@zhiyun/cloud-contracts';
const config = readConfig(),
  db = database(config.CLOUD_DATABASE_URL);
try {
  const address = email.parse(process.env.CLOUD_BOOTSTRAP_EMAIL),
    pass = password.parse(process.env.CLOUD_BOOTSTRAP_PASSWORD),
    secret = new OTPAuth.Secret({ size: 20 });
  const digest = await Bun.password.hash(pass, { algorithm: 'argon2id' });
  await db.sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(947154)`;
    if ((await tx`select 1 from cloud_staff`).length)
      throw new Error('First administrator already exists; use Admin staff management');
    await tx`insert into cloud_staff(email,password_hash,mfa_secret,role) values (${address},${digest},${encrypt(secret.base32, config.CLOUD_MFA_KEY)},'owner')`;
  });
  console.info(
    'Scan or import this one-time enrollment URI into your authenticator. Store it securely:',
  );
  console.info(new OTPAuth.TOTP({ issuer: 'ZhiYun Admin', label: address, secret }).toString());
} finally {
  await db.close();
}
