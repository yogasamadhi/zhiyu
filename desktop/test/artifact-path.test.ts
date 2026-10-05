import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { resolveHostArtifact } from '../src/artifact-path.js';
it('saves nested analysis/corpus artifacts while rejecting traversal and symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zhiyun-artifact-path-'));
  try {
    const nested = join(root, 'artifacts', 'corpus', 'version');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'documents.jsonl'), '{}');
    expect(await resolveHostArtifact(root, 'corpus/version/documents.jsonl')).toBe(
      await realpath(join(nested, 'documents.jsonl')),
    );
    for (const key of ['../outside', '/absolute', 'corpus/../version', 'corpus\\version'])
      await expect(resolveHostArtifact(root, key)).rejects.toThrow();
    await writeFile(join(root, 'outside'), 'private');
    await symlink(join(root, 'outside'), join(nested, 'link'));
    await expect(resolveHostArtifact(root, 'corpus/version/link')).rejects.toThrow('symlinks');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
