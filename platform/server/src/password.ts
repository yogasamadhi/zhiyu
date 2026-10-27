import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

// Password hashing uses the platform Argon2id primitive. The encoded form
// follows the PHC string layout so stored credentials stay portable between
// runtimes and the verification path never stores the plaintext password.
const memoryCost = 65_536;
const timeCost = 3;
const parallelism = 1;
const hashLength = 32;
const saltLength = 16;

interface Argon2Parameters {
  memory: number;
  passes: number;
  parallelism: number;
  tagLength: number;
}

interface ParsedHash {
  algorithm: 'argon2id' | 'argon2i' | 'argon2d';
  parameters: Argon2Parameters;
  salt: Buffer;
  hash: Buffer;
}

function derive(
  algorithm: ParsedHash['algorithm'],
  message: Buffer,
  salt: Buffer,
  parameters: Argon2Parameters,
): Promise<Buffer> {
  return new Promise((done, fail) => {
    argon2(
      algorithm,
      {
        message,
        nonce: salt,
        parallelism: parameters.parallelism,
        tagLength: parameters.tagLength,
        memory: parameters.memory,
        passes: parameters.passes,
      },
      (error, result) => {
        if (error) fail(error);
        else done(result);
      },
    );
  });
}

function encode(value: Buffer): string {
  return value.toString('base64').replace(/=+$/u, '');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(saltLength);
  const digest = await derive('argon2id', Buffer.from(password, 'utf8'), salt, {
    memory: memoryCost,
    passes: timeCost,
    parallelism,
    tagLength: hashLength,
  });
  return [
    '$argon2id$v=19',
    `m=${memoryCost},t=${timeCost},p=${parallelism}`,
    encode(salt),
    encode(digest),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const digest = await derive(
    parsed.algorithm,
    Buffer.from(password, 'utf8'),
    parsed.salt,
    parsed.parameters,
  );
  if (digest.length !== parsed.hash.length) return false;
  return timingSafeEqual(digest, parsed.hash);
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== '') return null;
  const algorithm = parts[1] as ParsedHash['algorithm'];
  if (!['argon2id', 'argon2i', 'argon2d'].includes(algorithm)) return null;
  const parameters: Argon2Parameters = {
    memory: memoryCost,
    passes: timeCost,
    parallelism,
    tagLength: hashLength,
  };
  for (const entry of parts[3]!.split(',')) {
    const [key, value] = entry.split('=');
    const number = Number(value);
    if (!Number.isInteger(number) || number <= 0) return null;
    if (key === 'm') parameters.memory = number;
    else if (key === 't') parameters.passes = number;
    else if (key === 'p') parameters.parallelism = number;
    else return null;
  }
  const salt = Buffer.from(parts[4]!, 'base64');
  const hash = Buffer.from(parts[5]!, 'base64');
  if (!salt.length || !hash.length) return null;
  parameters.tagLength = hash.length;
  return { algorithm, parameters, salt, hash };
}
