import { randomBytes, scrypt as nodeScrypt, timingSafeEqual, createHash } from 'node:crypto';
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;

export function validatePassword(password: string): void {
  if (password.length < 12) throw new Error('Password must contain at least 12 characters');
  if (Buffer.byteLength(password, 'utf8') > 1_024) throw new Error('Password is too long');
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(16);
  const derived = await derive(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEMORY,
  });
  return [
    'scrypt',
    'v=1',
    `N=${SCRYPT_N}`,
    `r=${SCRYPT_R}`,
    `p=${SCRYPT_P}`,
    `l=${KEY_LENGTH}`,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  try {
    const [algorithm, version, nValue, rValue, pValue, lengthValue, saltValue, hashValue] =
      encoded.split('$');
    if (algorithm !== 'scrypt' || version !== 'v=1') return false;
    const N = integerParameter(nValue, 'N');
    const r = integerParameter(rValue, 'r');
    const p = integerParameter(pValue, 'p');
    const length = integerParameter(lengthValue, 'l');
    if (N !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P || length !== KEY_LENGTH) return false;
    if (!saltValue || !hashValue) return false;
    const salt = Buffer.from(saltValue, 'base64url');
    const expected = Buffer.from(hashValue, 'base64url');
    if (salt.length !== 16 || expected.length !== KEY_LENGTH) return false;
    const actual = await derive(password, salt, length, {
      N,
      r,
      p,
      maxmem: MAX_MEMORY,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function derive(
  password: string,
  salt: Buffer,
  length: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, length, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

export function issueOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function constantTimeTextEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function integerParameter(value: string | undefined, name: string): number {
  const prefix = `${name}=`;
  if (!value?.startsWith(prefix)) throw new Error(`Missing ${name}`);
  const result = Number(value.slice(prefix.length));
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`Invalid ${name}`);
  return result;
}
