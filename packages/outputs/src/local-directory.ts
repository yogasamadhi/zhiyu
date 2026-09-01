import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ExportError } from '@zhiyun/contracts';
import { booleanConfig, materializeRecords, parseFields, parseFormat } from './serialization.js';
import type { OutputAdapter, OutputDeliveryInput, OutputDeliveryResult } from './types.js';

interface LocalDirectoryConfig {
  root: string;
  basePath: string;
  taskSlug: string;
  pathTemplate: string;
  format: 'csv' | 'jsonl' | 'parquet';
  fields: string[];
  includeSourceUrl: boolean;
  latest: boolean;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ExportError(`${label} is required`);
  return value.trim();
}

export function safeRelativePath(value: string, label = 'Output path'): string {
  if (!value || value.includes('\0') || isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new ExportError(`${label} must be a safe relative path`);
  }
  const segments = value.split(/[\\/]+/);
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new ExportError(`${label} must not contain empty, dot, or parent segments`);
  }
  return segments.join('/');
}

function safeSlug(value: unknown, fallback: string): string {
  const slug = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,119}$/u.test(slug) || slug === '.' || slug === '..') {
    throw new ExportError('Task slug may only contain letters, numbers, dot, underscore, or dash');
  }
  return slug;
}

function parseConfig(
  input: Pick<OutputDeliveryInput, 'destination' | 'credential'>,
): LocalDirectoryConfig {
  const config = input.destination.config;
  const credential = objectValue(input.credential);
  // Headless deployments pin every destination to the administrator-owned root.
  // Desktop grants an explicit directory reference through the host capability.
  const configuredRoot =
    process.env.ZHIYUN_OUTPUT_ROOT ?? credential.directoryPath ?? credential.rootPath;
  const root = nonEmptyString(configuredRoot, 'An authorized output directory');
  if (!isAbsolute(root)) throw new ExportError('The authorized output directory must be absolute');
  const basePathValue = config.basePath ?? config.subdirectory ?? '';
  const basePath =
    basePathValue === ''
      ? ''
      : safeRelativePath(nonEmptyString(basePathValue, 'Base path'), 'Base path');
  const format = parseFormat(config.format, 'csv');
  const extension = format === 'jsonl' ? 'jsonl' : format;
  const pathTemplate = nonEmptyString(
    config.pathTemplate ?? `{taskSlug}/{yyyy}/{mm}/{runId}.${extension}`,
    'Path template',
  );
  if (!pathTemplate.includes('{runId}')) {
    throw new ExportError('Local-directory archive pathTemplate must contain {runId}');
  }
  return {
    root: resolve(root),
    basePath,
    taskSlug: safeSlug(config.taskSlug, input.destination.id),
    pathTemplate,
    format,
    fields: parseFields(config.fields ?? config.columns),
    includeSourceUrl: booleanConfig(config.includeSourceUrl, true),
    latest: booleanConfig(config.latest ?? config.updateLatest, true),
  };
}

function renderPath(config: LocalDirectoryConfig, runId: string, now: Date): string {
  const values: Record<string, string> = {
    taskSlug: config.taskSlug,
    yyyy: String(now.getUTCFullYear()).padStart(4, '0'),
    mm: String(now.getUTCMonth() + 1).padStart(2, '0'),
    dd: String(now.getUTCDate()).padStart(2, '0'),
    runId,
    ext: config.format,
  };
  const rendered = config.pathTemplate.replace(/\{([^{}]+)\}/g, (_match, key: string) => {
    const replacement = values[key];
    if (!replacement) throw new ExportError(`Unsupported output path placeholder: {${key}}`);
    return replacement;
  });
  if (/[{}]/.test(rendered)) throw new ExportError('Output path template contains invalid braces');
  return safeRelativePath(config.basePath ? `${config.basePath}/${rendered}` : rendered);
}

function inside(root: string, candidate: string) {
  const path = relative(root, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function ensureSafeParent(root: string, destination: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const actualRoot = await realpath(root);
  const parent = resolve(destination, '..');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const actualParent = await realpath(parent);
  if (!inside(actualRoot, actualParent))
    throw new ExportError('Output path escapes the authorized directory');
  return { actualRoot, actualParent };
}

async function digestFile(path: string) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

async function pathExists(path: string) {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw new ExportError('Output files must not be symbolic links');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function publishLatest(source: string, latest: string) {
  const temporary = `${latest}.${randomUUID()}.tmp`;
  await copyFile(source, temporary);
  await rename(temporary, latest).catch(async (error) => {
    await rm(temporary, { force: true });
    throw error;
  });
}

export class LocalDirectoryOutputAdapter implements OutputAdapter {
  readonly type = 'local-directory' as const;

  async test(input: Pick<OutputDeliveryInput, 'destination' | 'credential' | 'signal'>) {
    const config = parseConfig(input);
    renderPath(config, 'connection-test', new Date(0));
    if (input.signal?.aborted) throw input.signal.reason ?? new Error('Output test aborted');
    await mkdir(config.root, { recursive: true, mode: 0o700 });
    const root = await realpath(config.root);
    const probeDirectory = resolve(root, `.zhiyun-output-test-${randomUUID()}`);
    if (!inside(root, probeDirectory)) throw new ExportError('Output test path is invalid');
    await mkdir(probeDirectory, { mode: 0o700 });
    const source = resolve(probeDirectory, 'probe.tmp');
    const target = resolve(probeDirectory, 'probe');
    try {
      await writeFile(source, 'zhiyun-output-test', { flag: 'wx', mode: 0o600 });
      await rename(source, target);
      await unlink(target);
    } finally {
      await rm(probeDirectory, { recursive: true, force: true });
    }
  }

  async deliver(input: OutputDeliveryInput): Promise<OutputDeliveryResult> {
    const config = parseConfig(input);
    if (input.artifact && input.artifact.format !== config.format) {
      throw new ExportError('The materialized artifact format does not match the destination');
    }
    const relativeArchive = renderPath(config, input.runId, new Date());
    const archive = resolve(config.root, relativeArchive);
    if (!inside(config.root, archive))
      throw new ExportError('Output path escapes the authorized directory');
    await ensureSafeParent(config.root, archive);
    const temporary = `${archive}.${randomUUID()}.tmp`;
    let materialized: Awaited<ReturnType<typeof materializeRecords>> | undefined;
    try {
      if (input.artifact) {
        await copyFile(input.artifact.path, temporary);
        const copiedDigest = await digestFile(temporary);
        if (copiedDigest !== input.artifact.sha256) {
          throw new ExportError('The materialized output artifact checksum does not match');
        }
        materialized = {
          path: temporary,
          delivered: input.artifact.delivered,
          sha256: input.artifact.sha256,
          bytes: input.artifact.bytes,
          fields: input.artifact.fields,
        };
      } else {
        materialized = await materializeRecords(
          temporary,
          input.records,
          {
            format: config.format,
            fields: config.fields,
            includeSourceUrl: config.includeSourceUrl,
          },
          input.signal,
        );
      }
      if (await pathExists(archive)) {
        const existingDigest = await digestFile(archive);
        if (existingDigest !== materialized.sha256) {
          throw new ExportError(
            'The immutable output archive already exists with different content',
          );
        }
        await rm(temporary, { force: true });
      } else {
        await rename(temporary, archive);
      }
      if (config.latest) {
        const latest = resolve(
          config.root,
          config.basePath,
          config.taskSlug,
          `latest.${config.format}`,
        );
        if (!inside(config.root, latest)) throw new ExportError('Latest output path is invalid');
        await ensureSafeParent(config.root, latest);
        await publishLatest(archive, latest);
      }
      return {
        responseStatus: null,
        delivered: materialized.delivered,
        format: config.format,
        artifactId: input.artifact?.id ?? null,
        finalLocation: archive,
        sha256: materialized.sha256,
        deliveredRecordCount: materialized.delivered,
      };
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
