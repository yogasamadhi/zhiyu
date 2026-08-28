import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ArtifactStore, CredentialStore } from '@zhiyun/contracts';

export class FileArtifactStore implements ArtifactStore {
  constructor(private readonly directory: string) {}

  async write(filename: string, data: Buffer): Promise<{ storageKey: string; size: number }> {
    await mkdir(this.directory, { recursive: true });
    const storageKey = `${crypto.randomUUID()}-${basename(filename)}`;
    await writeFile(join(this.directory, storageKey), data, { mode: 0o600 });
    return { storageKey, size: data.byteLength };
  }

  async writeStream(
    filename: string,
    data: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<{ storageKey: string; size: number }> {
    await mkdir(this.directory, { recursive: true });
    const storageKey = `${crypto.randomUUID()}-${basename(filename)}`;
    const path = join(this.directory, storageKey);
    const handle = await open(path, 'wx', 0o600);
    let size = 0;
    try {
      for await (const chunk of data) {
        if (signal?.aborted) throw new Error('Artifact write was canceled');
        await handle.write(chunk);
        size += chunk.byteLength;
      }
      await handle.sync();
      return { storageKey, size };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(path).catch(() => undefined);
      throw error;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async read(storageKey: string): Promise<Buffer> {
    if (basename(storageKey) !== storageKey) throw new Error('Invalid artifact storage key');
    return readFile(join(this.directory, storageKey));
  }

  readStream(storageKey: string): AsyncIterable<Uint8Array> {
    if (basename(storageKey) !== storageKey) throw new Error('Invalid artifact storage key');
    return createReadStream(join(this.directory, storageKey));
  }

  async delete(storageKey: string): Promise<void> {
    if (basename(storageKey) !== storageKey) throw new Error('Invalid artifact storage key');
    await unlink(join(this.directory, storageKey)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

interface EncryptedSecret {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class AesCredentialStore implements CredentialStore {
  private readonly key: Buffer;

  constructor(
    private readonly directory: string,
    keyBase64: string | undefined,
    production = process.env.NODE_ENV === 'production',
  ) {
    if (!keyBase64 && production) {
      throw new Error('ZHIYUN_CREDENTIAL_KEY is required in production');
    }
    this.key = keyBase64 ? Buffer.from(keyBase64, 'base64') : randomBytes(32);
    if (this.key.byteLength !== 32) {
      throw new Error('ZHIYUN_CREDENTIAL_KEY must be a base64 encoded 32-byte key');
    }
  }

  async put(kind: string, value: unknown): Promise<string> {
    await mkdir(this.directory, { recursive: true });
    const reference = `${kind}-${crypto.randomUUID()}`;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    const encrypted: EncryptedSecret = {
      version: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    await writeFile(join(this.directory, reference), JSON.stringify(encrypted), { mode: 0o600 });
    return reference;
  }

  async resolve<T = unknown>(reference: string): Promise<T> {
    if (basename(reference) !== reference) throw new Error('Invalid credential reference');
    const encrypted = JSON.parse(
      await readFile(join(this.directory, reference), 'utf8'),
    ) as EncryptedSecret;
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(encrypted.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
    const cleartext = Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(cleartext.toString('utf8')) as T;
  }

  async delete(reference: string): Promise<void> {
    if (basename(reference) !== reference) throw new Error('Invalid credential reference');
    await unlink(join(this.directory, reference)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export class HostCredentialStore implements CredentialStore {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Host capability request failed: HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  async put(kind: string, value: unknown): Promise<string> {
    return (await this.request<{ reference: string }>('/credentials/put', { kind, value }))
      .reference;
  }

  async resolve<T = unknown>(reference: string): Promise<T> {
    return (await this.request<{ value: T }>('/credentials/resolve', { reference })).value;
  }

  async delete(reference: string): Promise<void> {
    await this.request('/credentials/delete', { reference });
  }
}
