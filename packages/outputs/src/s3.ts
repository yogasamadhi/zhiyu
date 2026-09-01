import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { ExportError } from '@zhiyun/contracts';
import { booleanConfig, materializeRecords, parseFields, parseFormat } from './serialization.js';
import type { OutputAdapter, OutputDeliveryInput, OutputDeliveryResult } from './types.js';

interface S3Config {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle: boolean;
  prefix: string;
  taskSlug: string;
  pathTemplate: string;
  format: 'csv' | 'jsonl' | 'parquet';
  fields: string[];
  includeSourceUrl: boolean;
  latest: boolean;
  serverSideEncryption?: 'AES256' | 'aws:kms';
  kmsKeyId?: string;
}

interface S3Credential {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface S3ObjectMetadata {
  sha256?: string;
  runId?: string;
}

export interface S3PutInput {
  key: string;
  bodyPath: string;
  bytes: number;
  sha256: string;
  contentType: string;
  metadata: Record<string, string>;
  serverSideEncryption?: 'AES256' | 'aws:kms';
  kmsKeyId?: string;
  signal?: AbortSignal;
}

export interface S3Transport {
  testBucket(signal?: AbortSignal): Promise<void>;
  headObject(key: string, signal?: AbortSignal): Promise<S3ObjectMetadata | null>;
  putObject(input: S3PutInput): Promise<void>;
  deleteObject(key: string, signal?: AbortSignal): Promise<void>;
}

interface S3OutputAdapterOptions {
  transport?: S3Transport;
  fetch?: typeof fetch;
  now?: () => Date;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeObjectPath(value: string, label: string, allowEmpty = false) {
  if (allowEmpty && value === '') return '';
  if (!value || value.includes('\0') || value.startsWith('/') || value.startsWith('\\')) {
    throw new ExportError(`${label} must be a safe relative object path`);
  }
  const segments = value.split(/[\\/]+/);
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new ExportError(`${label} must not contain empty, dot, or parent segments`);
  }
  return segments.join('/');
}

function safeSlug(value: unknown, fallback: string) {
  const slug = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{0,119}$/u.test(slug) || slug === '.' || slug === '..') {
    throw new ExportError('S3 task slug is invalid');
  }
  return slug;
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseConfig(input: Pick<OutputDeliveryInput, 'destination'>): S3Config {
  const config = input.destination.config;
  const bucket = typeof config.bucket === 'string' ? config.bucket.trim() : '';
  if (!/^(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new ExportError('A valid DNS-compatible S3 bucket is required');
  }
  const region = typeof config.region === 'string' ? config.region.trim() : '';
  if (!/^[a-z0-9-]{3,32}$/.test(region)) throw new ExportError('A valid S3 region is required');
  const endpoint = optionalString(config.endpoint);
  if (endpoint) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new ExportError('S3 endpoint must be a valid URL');
    }
    const local =
      url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
      throw new ExportError('S3 endpoint must use HTTPS (HTTP is only allowed for localhost)');
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new ExportError('S3 endpoint must not include credentials, query, or fragment');
    }
  }
  const prefixValue =
    typeof config.prefix === 'string' ? config.prefix.trim().replace(/\/$/, '') : '';
  const prefix = safeObjectPath(prefixValue, 'S3 prefix', true);
  const format = parseFormat(config.format, 'csv');
  const kmsKeyId = optionalString(config.kmsKeyId);
  const pathTemplate =
    typeof config.pathTemplate === 'string' && config.pathTemplate.trim()
      ? config.pathTemplate.trim()
      : `{taskSlug}/{yyyy}/{mm}/{runId}.${format}`;
  if (!pathTemplate.includes('{runId}')) {
    throw new ExportError('S3 archive pathTemplate must contain {runId}');
  }
  return {
    bucket,
    region,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: booleanConfig(config.forcePathStyle, Boolean(endpoint)),
    prefix,
    taskSlug: safeSlug(config.taskSlug, input.destination.id),
    pathTemplate,
    format,
    fields: parseFields(config.fields ?? config.columns),
    includeSourceUrl: booleanConfig(config.includeSourceUrl, true),
    latest: booleanConfig(config.latest ?? config.updateLatest, true),
    ...(config.serverSideEncryption === 'AES256' || config.serverSideEncryption === 'aws:kms'
      ? { serverSideEncryption: config.serverSideEncryption }
      : config.serverSideEncryption === undefined
        ? {}
        : (() => {
            throw new ExportError('S3 server-side encryption must be AES256 or aws:kms');
          })()),
    ...(kmsKeyId ? { kmsKeyId } : {}),
  };
}

function parseCredential(value: unknown): S3Credential | undefined {
  const credential = objectValue(value);
  const accessKeyId = optionalString(credential.accessKeyId) ?? process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey =
    optionalString(credential.secretAccessKey) ?? process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = optionalString(credential.sessionToken) ?? process.env.AWS_SESSION_TOKEN;
  if (!accessKeyId && !secretAccessKey) return undefined;
  if (!accessKeyId || !secretAccessKey)
    throw new ExportError('S3 accessKeyId and secretAccessKey must be configured together');
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

function renderKey(config: S3Config, runId: string, now: Date) {
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
    if (!replacement) throw new ExportError(`Unsupported S3 path placeholder: {${key}}`);
    return replacement;
  });
  if (/[{}]/.test(rendered)) throw new ExportError('S3 path template contains invalid braces');
  return safeObjectPath(config.prefix ? `${config.prefix}/${rendered}` : rendered, 'S3 object key');
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * AWS SDK-backed transport. The SDK provides the full Node credential chain
 * (environment, shared config, web identity and instance/container roles),
 * while Upload performs bounded multipart uploads and aborts incomplete parts.
 */
export class AwsSigV4S3Transport implements S3Transport {
  readonly #config: S3Config;
  readonly #client: S3Client;

  constructor(config: S3Config, credential: S3Credential | undefined) {
    this.#config = config;
    this.#client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle,
      ...(credential ? { credentials: credential } : {}),
    });
  }

  async testBucket(signal?: AbortSignal) {
    await this.#client.send(
      new HeadBucketCommand({ Bucket: this.#config.bucket }),
      signal ? { abortSignal: signal } : undefined,
    );
  }

  async headObject(key: string, signal?: AbortSignal): Promise<S3ObjectMetadata | null> {
    try {
      const response = await this.#client.send(
        new HeadObjectCommand({ Bucket: this.#config.bucket, Key: key }),
        signal ? { abortSignal: signal } : undefined,
      );
      const objectSha = response.Metadata?.sha256;
      const runId = response.Metadata?.['zhiyun-run-id'];
      return {
        ...(objectSha ? { sha256: objectSha } : {}),
        ...(runId ? { runId } : {}),
      };
    } catch (error) {
      const metadata = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (metadata.name === 'NotFound' || metadata.$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  }

  async putObject(input: S3PutInput) {
    const body = createReadStream(input.bodyPath);
    const parameters: PutObjectCommandInput = {
      Bucket: this.#config.bucket,
      Key: input.key,
      Body: body,
      ContentLength: input.bytes,
      ContentType: input.contentType,
      Metadata: input.metadata,
      ...(input.serverSideEncryption ? { ServerSideEncryption: input.serverSideEncryption } : {}),
      ...(input.kmsKeyId ? { SSEKMSKeyId: input.kmsKeyId } : {}),
    };
    if (input.bytes < 8 * 1_024 * 1_024) {
      await this.#client.send(
        new PutObjectCommand(parameters),
        input.signal ? { abortSignal: input.signal } : undefined,
      );
      return;
    }
    const upload = new Upload({
      client: this.#client,
      params: parameters,
      queueSize: 4,
      partSize: 8 * 1_024 * 1_024,
      leavePartsOnError: false,
    });
    const abort = () => void upload.abort();
    input.signal?.addEventListener('abort', abort, { once: true });
    try {
      await upload.done();
    } finally {
      input.signal?.removeEventListener('abort', abort);
    }
  }

  async deleteObject(key: string, signal?: AbortSignal) {
    await this.#client.send(
      new DeleteObjectCommand({ Bucket: this.#config.bucket, Key: key }),
      signal ? { abortSignal: signal } : undefined,
    );
  }
}

function contentType(format: S3Config['format']) {
  if (format === 'csv') return 'text/csv; charset=utf-8';
  if (format === 'jsonl') return 'application/x-ndjson';
  return 'application/vnd.apache.parquet';
}

export class S3OutputAdapter implements OutputAdapter {
  readonly type = 's3' as const;
  readonly #options: S3OutputAdapterOptions;

  constructor(options: S3OutputAdapterOptions = {}) {
    this.#options = options;
  }

  #transport(input: Pick<OutputDeliveryInput, 'destination' | 'credential'>, config: S3Config) {
    return (
      this.#options.transport ?? new AwsSigV4S3Transport(config, parseCredential(input.credential))
    );
  }

  async test(input: Pick<OutputDeliveryInput, 'destination' | 'credential' | 'signal'>) {
    const config = parseConfig(input);
    renderKey(config, 'connection-test', new Date(0));
    const transport = this.#transport(input, config);
    await transport.testBucket(input.signal);
    const directory = await mkdtemp(join(tmpdir(), 'zhiyun-s3-test-'));
    const path = join(directory, 'probe');
    const key = `${config.prefix ? `${config.prefix}/` : ''}.zhiyun-test/${randomUUID()}`;
    try {
      await writeFile(path, 'zhiyun-output-test', { mode: 0o600 });
      const digest = sha256('zhiyun-output-test');
      await transport.putObject({
        key,
        bodyPath: path,
        bytes: Buffer.byteLength('zhiyun-output-test'),
        sha256: digest,
        contentType: 'text/plain',
        metadata: { sha256: digest, 'zhiyun-run-id': 'connection-test' },
        ...(input.signal ? { signal: input.signal } : {}),
      });
      await transport.deleteObject(key, input.signal);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async deliver(input: OutputDeliveryInput): Promise<OutputDeliveryResult> {
    const config = parseConfig(input);
    if (input.artifact && input.artifact.format !== config.format) {
      throw new ExportError('The materialized artifact format does not match the destination');
    }
    const transport = this.#transport(input, config);
    const directory = input.artifact
      ? undefined
      : await mkdtemp(join(tmpdir(), 'zhiyun-s3-output-'));
    const path = input.artifact
      ? input.artifact.path
      : join(directory as string, `records.${config.format}`);
    try {
      const materialized =
        input.artifact ??
        (await materializeRecords(
          path,
          input.records,
          {
            format: config.format,
            fields: config.fields,
            includeSourceUrl: config.includeSourceUrl,
          },
          input.signal,
        ));
      const archiveKey = renderKey(config, input.runId, new Date());
      const metadata = { sha256: materialized.sha256, 'zhiyun-run-id': input.runId };
      const existing = await transport.headObject(archiveKey, input.signal);
      if (existing && (existing.sha256 !== materialized.sha256 || existing.runId !== input.runId)) {
        throw new ExportError(
          'The immutable S3 archive already exists with different runId or sha256 metadata',
        );
      }
      const put = async (key: string) =>
        transport.putObject({
          key,
          bodyPath: path,
          bytes: materialized.bytes,
          sha256: materialized.sha256,
          contentType: contentType(config.format),
          metadata,
          ...(config.serverSideEncryption
            ? { serverSideEncryption: config.serverSideEncryption }
            : {}),
          ...(config.kmsKeyId ? { kmsKeyId: config.kmsKeyId } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
      if (!existing) await put(archiveKey);
      if (config.latest) {
        const latestKey = safeObjectPath(
          `${config.prefix ? `${config.prefix}/` : ''}${config.taskSlug}/latest.${config.format}`,
          'S3 latest object key',
        );
        const currentLatest = await transport.headObject(latestKey, input.signal);
        if (currentLatest?.sha256 !== materialized.sha256 || currentLatest.runId !== input.runId) {
          await put(latestKey);
        }
      }
      return {
        responseStatus: 200,
        delivered: materialized.delivered,
        format: config.format,
        artifactId: input.artifact?.id ?? null,
        finalLocation: archiveKey,
        sha256: materialized.sha256,
        deliveredRecordCount: materialized.delivered,
      };
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}
