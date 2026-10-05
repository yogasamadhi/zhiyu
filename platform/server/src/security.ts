import { createHash, randomBytes, createCipheriv, createDecipheriv, createHmac } from 'node:crypto';
import * as OTPAuth from 'otpauth';
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export function encrypt(value: string, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(key).digest(), iv);
  return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]).toString(
    'base64',
  );
}
export function decrypt(value: string, key: string): string {
  const b = Buffer.from(value, 'base64');
  const cipher = createDecipheriv(
    'aes-256-gcm',
    createHash('sha256').update(key).digest(),
    b.subarray(0, 12),
  );
  cipher.setAuthTag(b.subarray(-16));
  return Buffer.concat([cipher.update(b.subarray(12, -16)), cipher.final()]).toString();
}
export function totp(secretValue: string, token: string, now: Date): number | null {
  const auth = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secretValue),
    digits: 6,
    period: 30,
  });
  const delta = auth.validate({ token, timestamp: now.getTime(), window: 1 });
  return delta === null ? null : Math.floor(now.getTime() / 30000) + delta;
}
export const sign = (key: string, value: string) =>
  createHmac('sha256', key).update(value).digest('hex');
