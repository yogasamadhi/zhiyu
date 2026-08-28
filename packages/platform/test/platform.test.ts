import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AesCredentialStore, FileArtifactStore } from '../src/index.js';

describe('platform stores', () => {
  it('encrypts headless credentials with AES-256-GCM', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zhiyun-credentials-'));
    const key = Buffer.alloc(32, 7).toString('base64');
    const store = new AesCredentialStore(directory, key, true);
    const reference = await store.put('headers', { Authorization: 'Bearer secret' });
    expect(await store.resolve(reference)).toEqual({ Authorization: 'Bearer secret' });
    expect(await readFile(join(directory, reference), 'utf8')).not.toContain('Bearer secret');
  });

  it('writes artifacts only under its controlled directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zhiyun-artifacts-'));
    const store = new FileArtifactStore(directory);
    const result = await store.write('../unsafe.json', Buffer.from('{}'));
    expect(result.storageKey).toContain('unsafe.json');
    await expect(store.read('../outside')).rejects.toThrow('Invalid artifact storage key');
  });

  it('streams artifacts and removes incomplete files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zhiyun-artifacts-stream-'));
    const store = new FileArtifactStore(directory);
    async function* chunks() {
      yield Buffer.from('first');
      yield Buffer.from('-second');
    }
    const result = await store.writeStream('large.csv', chunks());
    const read: Buffer[] = [];
    for await (const chunk of store.readStream(result.storageKey)) read.push(Buffer.from(chunk));
    expect(Buffer.concat(read).toString()).toBe('first-second');
    expect(result.size).toBe(12);

    async function* broken() {
      yield Buffer.from('partial');
      throw new Error('broken stream');
    }
    await expect(store.writeStream('broken.csv', broken())).rejects.toThrow('broken stream');
    expect((await readdir(directory)).filter((name) => name.includes('broken.csv'))).toEqual([]);
  });
});
