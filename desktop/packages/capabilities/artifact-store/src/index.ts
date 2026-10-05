import { createReadStream } from 'node:fs';
import { copyFile, link, lstat, mkdir, realpath, rm, stat, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { ArtifactStore, JobWorkspace, StoredArtifactFile } from '@zhiyun/platform-core';

const SAFE_JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class LocalArtifactStore implements ArtifactStore {
  private readonly dataDirectory: string;
  private artifactRoot = '';
  private workspaceRoot = '';
  private initialized = false;

  constructor(dataDirectory: string) {
    if (!dataDirectory.trim() || !isAbsolute(dataDirectory)) {
      throw new Error('Artifact data directory must be an absolute path');
    }
    const resolved = resolve(dataDirectory);
    if (resolved === parse(resolved).root) {
      throw new Error('Artifact data directory cannot be a filesystem root');
    }
    this.dataDirectory = resolved;
  }

  async initialize(): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true });
    const canonicalDataDirectory = await realpath(this.dataDirectory);
    const artifactRoot = join(canonicalDataDirectory, 'artifacts');
    const workspaceRoot = join(canonicalDataDirectory, 'job-workspaces');
    await mkdir(artifactRoot, { recursive: true });
    await mkdir(workspaceRoot, { recursive: true });
    this.artifactRoot = await realpath(artifactRoot);
    this.workspaceRoot = await realpath(workspaceRoot);
    assertChild(canonicalDataDirectory, this.artifactRoot);
    assertChild(canonicalDataDirectory, this.workspaceRoot);
    this.initialized = true;
  }

  async openWorkspace(jobId: string): Promise<JobWorkspace> {
    this.assertInitialized();
    validateJobId(jobId);
    const rootPath = join(this.workspaceRoot, jobId);
    await mkdir(rootPath, { recursive: true });
    const canonicalRoot = await realpath(rootPath);
    assertChild(this.workspaceRoot, canonicalRoot);
    return {
      jobId,
      rootPath: canonicalRoot,
      resolve: (relativePath) => resolveControlledPath(canonicalRoot, relativePath, false),
    };
  }

  async commitWorkspaceFile(
    jobId: string,
    relativeSource: string,
    storageKey: string,
  ): Promise<StoredArtifactFile> {
    this.assertInitialized();
    const workspace = await this.openWorkspace(jobId);
    const source = await resolveControlledPath(workspace.rootPath, relativeSource, true);
    const sourceStat = await lstat(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error('Artifact source must be a regular workspace file');
    }
    const sourceChecksum = await sha256File(source);

    const segments = validateRelativePath(storageKey);
    const canonicalParent = await ensureControlledDirectory(
      this.artifactRoot,
      segments.slice(0, -1),
    );
    const canonicalDestination = join(canonicalParent, segments.at(-1)!);
    if (await pathExists(canonicalDestination)) {
      const destinationStat = await lstat(canonicalDestination);
      if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) {
        throw new Error('Existing Artifact destination is not a regular file');
      }
      const checksum = await sha256File(canonicalDestination);
      if (checksum !== sourceChecksum) {
        throw new Error('Artifact storage key already exists with different content');
      }
      return { storageKey: segments.join('/'), size: destinationStat.size, checksum };
    }
    const temporary = `${canonicalDestination}.partial-${randomUUID()}`;
    try {
      await copyFile(source, temporary);
      await link(temporary, canonicalDestination);
      await unlink(temporary);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    const metadata = await stat(canonicalDestination);
    return { storageKey: segments.join('/'), size: metadata.size, checksum: sourceChecksum };
  }

  async resolveArtifact(storageKey: string): Promise<string> {
    this.assertInitialized();
    const segments = validateRelativePath(storageKey);
    return resolveControlledPath(this.artifactRoot, segments.join(sep), true);
  }

  async removeWorkspace(jobId: string): Promise<void> {
    this.assertInitialized();
    validateJobId(jobId);
    const target = join(this.workspaceRoot, jobId);
    const lexicalChild = relative(this.workspaceRoot, target);
    if (!lexicalChild || lexicalChild.startsWith('..') || isAbsolute(lexicalChild)) {
      throw new Error('Refusing uncontrolled workspace removal');
    }
    if (await pathExists(target)) {
      const canonicalTarget = await realpath(target);
      assertChild(this.workspaceRoot, canonicalTarget);
    }
    await rm(target, { recursive: true, force: true });
  }

  async close(): Promise<void> {
    this.initialized = false;
  }

  async removeArtifactDirectory(namespace: string, ownerId: string): Promise<void> {
    this.assertInitialized();
    validateJobId(namespace);
    validateJobId(ownerId);
    const target = join(this.artifactRoot, namespace, ownerId);
    if (await pathExists(target)) {
      const canonicalTarget = await realpath(target);
      assertChild(this.artifactRoot, canonicalTarget);
      // Do not follow a namespace or owner symlink when deleting a temporary tree.
      if (canonicalTarget !== target)
        throw new Error('Refusing symlinked Artifact directory removal');
    }
    await rm(target, { recursive: true, force: true });
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('Artifact store is not initialized');
  }
}

async function resolveControlledPath(
  root: string,
  relativePath: string,
  mustExist: boolean,
): Promise<string> {
  const segments = validateRelativePath(relativePath);
  const lexicalPath = join(root, ...segments);
  assertChild(root, lexicalPath);
  if (await pathExists(lexicalPath)) {
    const canonicalPath = await realpath(lexicalPath);
    assertChild(root, canonicalPath);
    return canonicalPath;
  }
  if (mustExist)
    throw Object.assign(new Error(`Controlled path does not exist: ${segments.join('/')}`), {
      code: 'ARTIFACT_NOT_FOUND',
    });
  const canonicalParent = await ensureControlledDirectory(root, segments.slice(0, -1));
  return join(canonicalParent, segments.at(-1)!);
}

async function ensureControlledDirectory(root: string, segments: string[]): Promise<string> {
  let current = root;
  for (const segment of segments) {
    const candidate = join(current, segment);
    await mkdir(candidate, { recursive: true });
    current = await realpath(candidate);
    assertChild(root, current);
  }
  return current;
}

function validateRelativePath(value: string): string[] {
  if (!value.trim() || value.includes('\\') || value.includes('\0') || isAbsolute(value)) {
    throw new Error('Artifact paths must be non-empty portable relative paths');
  }
  const segments = value.split('/');
  if (
    segments.some(
      (segment) =>
        !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]{1,255}$/.test(segment),
    )
  ) {
    throw new Error('Artifact path traversal is not allowed');
  }
  return segments;
}

function validateJobId(jobId: string): void {
  if (!SAFE_JOB_ID.test(jobId)) throw new Error('Invalid Job ID for workspace');
}

function assertChild(root: string, target: string): void {
  const child = relative(root, target);
  if (!child || child.startsWith('..') || isAbsolute(child)) {
    throw new Error(`Path escapes controlled root: ${target}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
