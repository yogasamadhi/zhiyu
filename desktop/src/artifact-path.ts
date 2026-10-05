import { isAbsolute, join, relative } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';

/** Resolve a Runtime-issued artifact key under the host's own artifact root. */
export async function resolveHostArtifact(dataDirectory: string, storageKey: string) {
  const segments = storageKey.split('/');
  if (
    !storageKey ||
    isAbsolute(storageKey) ||
    storageKey.includes('\\') ||
    segments.some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Invalid artifact storage key');
  const root = await realpath(join(dataDirectory, 'artifacts'));
  let candidate = root;
  for (const segment of segments) {
    candidate = join(candidate, segment);
    if ((await lstat(candidate)).isSymbolicLink())
      throw new Error('Artifact symlinks are forbidden');
  }
  const resolved = await realpath(candidate);
  const local = relative(root, resolved);
  if (!local || local.startsWith('..') || isAbsolute(local) || !(await lstat(resolved)).isFile())
    throw new Error('Artifact must be a file within the artifact root');
  return resolved;
}
