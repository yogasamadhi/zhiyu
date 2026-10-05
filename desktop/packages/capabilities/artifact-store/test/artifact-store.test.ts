import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalArtifactStore } from '../src/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; store: LocalArtifactStore }> {
  const root = await mkdtemp(join(tmpdir(), 'zhiyun-artifacts-'));
  roots.push(root);
  const store = new LocalArtifactStore(root);
  await store.initialize();
  return { root, store };
}

describe('local artifact store', () => {
  it('atomically commits a workspace file and returns its checksum', async () => {
    const { store } = await fixture();
    const workspace = await store.openWorkspace('job-1');
    const source = await workspace.resolve('output/result.json');
    await writeFile(source, '{"ok":true}');
    const committed = await store.commitWorkspaceFile(
      'job-1',
      'output/result.json',
      'analytics/result.json',
    );
    expect(committed).toMatchObject({
      storageKey: 'analytics/result.json',
      size: 11,
      checksum: '4062edaf750fb8074e7e83e0c9028c94e32468a8b6f1614774328ef045150f93',
    });
    expect(await readFile(await store.resolveArtifact(committed.storageKey), 'utf8')).toBe(
      '{"ok":true}',
    );
    await store.removeWorkspace('job-1');
  });

  it('reuses an existing content-addressed file only when the checksum matches', async () => {
    const { store } = await fixture();
    const firstWorkspace = await store.openWorkspace('job-first');
    await writeFile(await firstWorkspace.resolve('snapshot.parquet'), 'same-content');
    const first = await store.commitWorkspaceFile(
      'job-first',
      'snapshot.parquet',
      'datasets/fingerprint/snapshot.parquet',
    );

    const secondWorkspace = await store.openWorkspace('job-second');
    await writeFile(await secondWorkspace.resolve('snapshot.parquet'), 'same-content');
    const reused = await store.commitWorkspaceFile(
      'job-second',
      'snapshot.parquet',
      'datasets/fingerprint/snapshot.parquet',
    );
    expect(reused).toEqual(first);

    await writeFile(await secondWorkspace.resolve('different.parquet'), 'different-content');
    await expect(
      store.commitWorkspaceFile(
        'job-second',
        'different.parquet',
        'datasets/fingerprint/snapshot.parquet',
      ),
    ).rejects.toThrow('different content');
  });

  it('rejects traversal, absolute paths and unsafe Job IDs', async () => {
    const { store } = await fixture();
    await expect(store.openWorkspace('../escape')).rejects.toThrow('Invalid Job ID');
    const workspace = await store.openWorkspace('job-safe');
    await expect(workspace.resolve('../escape')).rejects.toThrow('traversal');
    await expect(store.resolveArtifact('/tmp/escape')).rejects.toThrow('relative paths');
    await expect(
      store.commitWorkspaceFile('job-safe', 'missing.parquet', '../escape.parquet'),
    ).rejects.toThrow();
  });

  it('refuses symlinks that escape a controlled workspace', async () => {
    const { root, store } = await fixture();
    const workspace = await store.openWorkspace('job-symlink');
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(outside, join(workspace.rootPath, 'linked'));
    await expect(workspace.resolve('linked/secret.txt')).rejects.toThrow('escapes controlled root');
  });

  it('removes only one owner tree and rejects broad or symlinked cleanup', async () => {
    const { root, store } = await fixture();
    const workspace = await store.openWorkspace('writer');
    await writeFile(await workspace.resolve('record.json'), 'owned');
    for (const key of [
      'collection-batches/run-one/batch.json',
      'collection-batches/run-two/batch.json',
      'datasets/old-snapshot/manifest.json',
    ])
      await store.commitWorkspaceFile('writer', 'record.json', key);
    await store.removeArtifactDirectory('collection-batches', 'run-one');
    await expect(
      store.resolveArtifact('collection-batches/run-one/batch.json'),
    ).rejects.toMatchObject({ code: 'ARTIFACT_NOT_FOUND' });
    expect(
      await readFile(await store.resolveArtifact('collection-batches/run-two/batch.json'), 'utf8'),
    ).toBe('owned');
    expect(
      await readFile(await store.resolveArtifact('datasets/old-snapshot/manifest.json'), 'utf8'),
    ).toBe('owned');
    await store.removeArtifactDirectory('collection-batches', 'run-one');
    await expect(store.removeArtifactDirectory('', 'run-two')).rejects.toThrow();
    await expect(
      store.removeArtifactDirectory('collection-batches', '../run-two'),
    ).rejects.toThrow();
    await symlink(join(root, 'artifacts', 'datasets'), join(root, 'artifacts', 'linked'));
    await expect(store.removeArtifactDirectory('linked', 'old-snapshot')).rejects.toThrow(
      'symlinked',
    );
    expect(
      await readFile(await store.resolveArtifact('datasets/old-snapshot/manifest.json'), 'utf8'),
    ).toBe('owned');
  });
});
