import { createHash } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { ArtifactStore } from '@zhiyun/platform-core';
import {
  ZhiYunError,
  observeDiagnosticOperation,
  diagnosticErrorCodeSchema,
  type CrawlBatch,
  type CrawlBatchCommit,
  type CrawlDetailCache,
  type CrawlDetailData,
  type CrawlListSpool,
  type CrawlPlanDefinition,
  type CrawlCheckpoint,
  type CrawlBrowserPagination,
  type CrawlSitemapSpool,
  type CrawlSitemapBatch,
  type DatasetSettings,
  type DiagnosticObserver,
} from '@zhiyun/shared';
import type { CollectionRepository, DatasetIngestionPort } from '../contracts/index.js';

const recordsSchema = z
  .array(z.object({ sourceUrl: z.string().url(), data: z.record(z.string(), z.unknown()) }))
  .max(250);
const detailSchema = z.object({
  data: z.record(z.string(), z.unknown()),
  recordMatches: z.number().int().nonnegative(),
  browserUsed: z.boolean(),
  failureCode: diagnosticErrorCodeSchema.optional(),
});
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const sitemapBatchSchema = z
  .object({
    requestId: z.string().regex(/^[a-f0-9]{64}$/),
    sequence: z.number().int().nonnegative(),
    entries: z
      .array(z.object({ url: z.string().url(), lastModified: z.string().nullable() }))
      .max(250),
    nodes: z
      .array(
        z.object({
          id: z.string().regex(/^[a-f0-9]{64}$/),
          url: z.string().url(),
          depth: z.number().int().min(0).max(3),
        }),
      )
      .max(250),
  })
  .refine((batch) => batch.entries.length + batch.nodes.length <= 250);

export async function cleanupCollectionBatches(
  repository: CollectionRepository,
  datasets: DatasetIngestionPort,
  artifacts: ArtifactStore,
  runId: string,
): Promise<void> {
  const run = await repository.getRun(runId);
  if (run) await repository.requestCrawlCleanup(runId, run.taskId, 'terminal');
  await artifacts.removeArtifactDirectory('collection-batches', runId);
  await artifacts.removeWorkspace(`collection-${runId}`);
  await datasets.discardIngestion(runId);
  await repository.clearCrawlSession(runId);
  // Keep the durable intent through handler callbacks and the Platform job ack.
  // A terminal failed job can then finish this same already-completed Run.
  if (run?.status !== 'succeeded') await repository.acknowledgeCrawlCleanup(runId);
}

export interface CollectionBatchWriterOptions {
  artifacts: ArtifactStore;
  taskId: string;
  runId: string;
  fingerprint: string;
  settings: DatasetSettings;
  dedupe: CrawlPlanDefinition['dedupe'];
  maxRecords: number;
  signal: AbortSignal;
  onDiagnostic?: DiagnosticObserver;
}

export class CollectionBatchWriter {
  readonly listSpool: CrawlListSpool;
  readonly detailCache: CrawlDetailCache;
  readonly sitemapSpool: CrawlSitemapSpool;
  readonly browserPagination: CrawlBrowserPagination;
  checkpoint!: CrawlCheckpoint;
  private readonly workspaceId: string;

  constructor(
    private readonly repository: CollectionRepository,
    private readonly datasets: DatasetIngestionPort,
    private readonly options: CollectionBatchWriterOptions,
  ) {
    this.workspaceId = `collection-${options.runId}`;
    this.browserPagination = {
      begin: (input) => {
        this.checkAbort();
        return this.repository.beginBrowserRound(
          this.options.runId,
          this.options.fingerprint,
          input,
        );
      },
      selected: (id, round, after) =>
        this.repository.listBrowserSelected(
          this.options.runId,
          this.options.fingerprint,
          id,
          round,
          after,
        ),
      complete: (id, round, state) => {
        this.checkAbort();
        return this.repository.completeBrowserRound(
          this.options.runId,
          this.options.fingerprint,
          id,
          round,
          state,
        );
      },
    };
    this.listSpool = {
      append: (batch) => this.appendList(batch),
      batches: () => this.listBatches(),
    };
    this.detailCache = {
      get: (key) => this.getDetail(key),
      put: (key, value) => this.putDetail(key, value),
    };
    this.sitemapSpool = {
      root: async (node, max) => {
        this.checkAbort();
        await this.repository.enqueueSitemapRoot(
          this.options.runId,
          this.options.fingerprint,
          node,
          max,
        );
      },
      nodes: (after) =>
        this.repository.listSitemapNodes(this.options.runId, this.options.fingerprint, after),
      append: (batch, maxSitemaps, maxUrls) => this.appendSitemap(batch, maxSitemaps, maxUrls),
      summary: () => this.repository.getSitemapState(this.options.runId, this.options.fingerprint),
      batches: (input) => this.sitemapBatches(input),
    };
  }

  async begin(): Promise<{ acceptedCount: number; committed: boolean }> {
    this.checkAbort();
    await this.repository.beginCrawlSession(this.options.runId, this.options.fingerprint);
    const workspace = await this.options.artifacts.openWorkspace(this.workspaceId);
    this.checkpoint = {
      queueScope: sha(`${this.options.runId}/${this.options.fingerprint}`),
      storageDirectory: dirname(await workspace.resolve('crawlee/queue.marker')),
      requests: (stage, after) =>
        this.repository.listCrawlRequests(
          this.options.runId,
          this.options.fingerprint,
          stage,
          after,
        ),
      ensure: (seed, max) =>
        this.repository.ensureCrawlRequest(this.options.runId, this.options.fingerprint, seed, max),
      reserveRecords: (id, available, max) =>
        this.repository.reserveCrawlRecords(
          this.options.runId,
          this.options.fingerprint,
          id,
          available,
          max,
        ),
      complete: (id, result, max) =>
        this.repository.completeCrawlRequest(
          this.options.runId,
          this.options.fingerprint,
          id,
          result,
          max,
        ),
      summary: () => this.repository.getCrawlSummary(this.options.runId, this.options.fingerprint),
    };
    return this.datasets.beginIngestion({
      sourceTaskId: this.options.taskId,
      sourceRunId: this.options.runId,
      fingerprint: this.options.fingerprint,
      settings: this.options.settings,
      dedupe: this.options.dedupe,
    });
  }

  async write(batch: CrawlBatch): Promise<CrawlBatchCommit> {
    return observeDiagnosticOperation(
      this.options.onDiagnostic,
      { kind: 'write', target: 'dataset', writePhase: 'staging' },
      async () => {
        this.checkBatch(batch);
        const records = recordsSchema.parse(batch.records);
        const key = sha(`${this.options.fingerprint}/final/${batch.requestId}/${batch.sequence}`);
        const payload = JSON.stringify(records);
        const artifactKey = `collection-batches/${this.options.runId}/${key}.json`;
        await this.commitFile(`${key}.json`, artifactKey, payload);
        this.checkAbort();
        return this.datasets.stageBatch({
          sourceRunId: this.options.runId,
          fingerprint: this.options.fingerprint,
          batchKey: key,
          checksum: sha(payload),
          artifactKey,
          records,
          maxRecords: this.options.maxRecords,
        });
      },
      (value) => ({ writtenCount: value.reused ? 0 : value.acceptedCount }),
      this.options.signal,
    );
  }

  async cleanup(): Promise<void> {
    // Only this run's transient trees and ledgers; projected records/Snapshots are separate.
    await cleanupCollectionBatches(
      this.repository,
      this.datasets,
      this.options.artifacts,
      this.options.runId,
    );
  }

  private async appendList(batch: CrawlBatch): Promise<void> {
    this.checkBatch(batch);
    const records = recordsSchema.parse(batch.records);
    const id = sha(`${this.options.fingerprint}/list/${batch.requestId}/${batch.sequence}`);
    const storageKey = `collection-batches/${this.options.runId}/list/${id}.json`;
    const payload = JSON.stringify(records);
    // Artifact first, then durable ledger. Replay verifies the same immutable contents.
    await this.commitFile(`list-${id}.json`, storageKey, payload);
    this.checkAbort();
    await this.repository.saveCrawlBatch(this.options.runId, this.options.fingerprint, {
      id,
      requestId: batch.requestId,
      sequence: batch.sequence,
      storageKey,
      checksum: sha(payload),
      rowCount: records.length,
    });
  }

  private async *listBatches(): AsyncIterable<CrawlBatch> {
    let afterRequest = 0;
    let requestsFound = false;
    while (true) {
      const page = await this.checkpoint.requests(undefined, afterRequest);
      if (!page.length) break;
      requestsFound = true;
      for (const request of page) {
        // Request ordinals are fixed before navigation, so parallel completion
        // and restart cannot change which duplicate row wins during projection.
        if (request.stage !== 'detail') yield* this.requestBatches(request.id);
        afterRequest = request.ordinal;
      }
    }
    if (!requestsFound) yield* this.requestBatches();
  }

  private async appendSitemap(
    value: CrawlSitemapBatch,
    maxSitemaps: number,
    maxUrls: number,
  ): Promise<void> {
    this.checkAbort();
    const batch = sitemapBatchSchema.parse(value);
    const id = sha(`${this.options.fingerprint}/discovery/${batch.requestId}/${batch.sequence}`);
    const storageKey = `collection-batches/${this.options.runId}/discovery/${id}.json`;
    const payload = JSON.stringify(batch);
    await this.commitFile(`discovery-${id}.json`, storageKey, payload);
    this.checkAbort();
    await this.repository.stageSitemapBatch(this.options.runId, this.options.fingerprint, {
      batch,
      id,
      checksum: sha(payload),
      storageKey,
      maxSitemaps,
      maxUrls,
    });
  }

  private async *sitemapBatches(
    input: Parameters<CrawlSitemapSpool['batches']>[0],
  ): AsyncIterable<CrawlBatch> {
    // Confirm every source Artifact before reading its SQLite discovery projection.
    let after = 0;
    while (true) {
      this.checkAbort();
      const page = await this.repository.listSitemapBatches(
        this.options.runId,
        this.options.fingerprint,
        after,
      );
      if (!page.length) break;
      for (const stored of page) {
        const payload = await readFile(
          await this.options.artifacts.resolveArtifact(stored.storageKey),
          'utf8',
        );
        if (sha(payload) !== stored.checksum)
          throw new Error('VALIDATION: Stored sitemap Artifact changed');
        const batch = sitemapBatchSchema.parse(JSON.parse(payload));
        if (
          batch.requestId !== stored.requestId ||
          batch.sequence !== stored.sequence ||
          batch.entries.length + batch.nodes.length !== stored.rowCount
        )
          throw new Error('VALIDATION: Stored sitemap Artifact changed');
        after = stored.ordinal;
      }
    }
    let cursor: { ordinal: number; modified: number } | undefined;
    let emitted = 0;
    let sequence = 0;
    while (emitted < input.limit) {
      this.checkAbort();
      const page = await this.repository.listSitemapEntries(
        this.options.runId,
        this.options.fingerprint,
        !!input.lastModifiedField,
        cursor,
      );
      if (!page.length) return;
      const selected = page.slice(0, input.limit - emitted);
      let records: CrawlBatch['records'] = [];
      let bytes = 2;
      for (const entry of selected) {
        const record = {
          sourceUrl: entry.url,
          data: {
            [input.urlField]: entry.url,
            ...(input.lastModifiedField && entry.lastModified
              ? { [input.lastModifiedField]: entry.lastModified }
              : {}),
          },
        };
        const size = Buffer.byteLength(JSON.stringify(record)) + 1;
        if (records.length && bytes + size > 1024 * 1024) {
          yield { requestId: input.requestId, sequence: sequence++, records };
          records = [];
          bytes = 2;
        }
        records.push(record);
        bytes += size;
      }
      if (records.length) yield { requestId: input.requestId, sequence: sequence++, records };
      emitted += selected.length;
      const last = selected.at(-1)!;
      cursor = { ordinal: last.ordinal, modified: last.modified };
    }
  }

  private async *requestBatches(requestId?: string): AsyncIterable<CrawlBatch> {
    let after = 0;
    while (true) {
      this.checkAbort();
      const page = await this.repository.listCrawlBatches(
        this.options.runId,
        this.options.fingerprint,
        after,
        requestId,
      );
      if (!page.length) return;
      for (const stored of page) {
        this.checkAbort();
        const payload = await readFile(
          await this.options.artifacts.resolveArtifact(stored.storageKey),
          'utf8',
        );
        if (sha(payload) !== stored.checksum)
          throw new Error('VALIDATION: Stored list batch checksum changed');
        const records = recordsSchema.parse(JSON.parse(payload));
        if (records.length !== stored.rowCount)
          throw new Error('VALIDATION: Stored list batch count changed');
        yield { requestId: stored.requestId, sequence: stored.sequence, records };
        after = stored.ordinal;
      }
    }
  }

  private async getDetail(key: string): Promise<CrawlDetailData | null> {
    this.checkKey(key);
    this.checkAbort();
    let path: string;
    try {
      path = await this.options.artifacts.resolveArtifact(
        `collection-batches/${this.options.runId}/details/${key}.json`,
      );
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ARTIFACT_NOT_FOUND'
      )
        return null;
      throw error;
    }
    const envelope = z
      .object({ fingerprint: z.string(), checksum: z.string(), value: detailSchema })
      .parse(JSON.parse(await readFile(path, 'utf8')));
    if (
      envelope.fingerprint !== this.options.fingerprint ||
      sha(JSON.stringify(envelope.value)) !== envelope.checksum
    )
      throw new Error('VALIDATION: Stored detail fingerprint or checksum changed');
    const { failureCode, ...value } = envelope.value;
    return failureCode === undefined ? value : { ...value, failureCode };
  }

  private async putDetail(key: string, value: CrawlDetailData): Promise<void> {
    this.checkKey(key);
    const data = detailSchema.parse(value);
    const envelope = {
      fingerprint: this.options.fingerprint,
      checksum: sha(JSON.stringify(data)),
      value: data,
    };
    await this.commitFile(
      `detail-${key}.json`,
      `collection-batches/${this.options.runId}/details/${key}.json`,
      JSON.stringify(envelope),
    );
  }

  private async commitFile(relative: string, storageKey: string, payload: string): Promise<void> {
    this.checkAbort();
    const workspace = await this.options.artifacts.openWorkspace(this.workspaceId);
    const path = await workspace.resolve(relative);
    await writeFile(path, payload, { mode: 0o600 });
    this.checkAbort();
    try {
      await this.options.artifacts.commitWorkspaceFile(this.workspaceId, relative, storageKey);
    } catch (error) {
      if (error instanceof Error && error.message.includes('already exists with different content'))
        throw new Error('VALIDATION: Batch payload changed during replay; start a new run', {
          cause: error,
        });
      throw error;
    }
    await unlink(path);
  }

  private checkAbort(): void {
    if (this.options.signal.aborted)
      throw new ZhiYunError('CANCELED', 'Collection batch write was canceled');
  }
  private checkKey(key: string): void {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('VALIDATION: Invalid batch identity');
  }
  private checkBatch(batch: CrawlBatch): void {
    this.checkAbort();
    this.checkKey(batch.requestId);
    if (!Number.isSafeInteger(batch.sequence) || batch.sequence < 0)
      throw new Error('VALIDATION: Invalid batch sequence');
  }
}
