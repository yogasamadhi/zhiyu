import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { AnalysisResultQueryError } from '../../contracts/index.js';
import type {
  AnalysisArtifactRef,
  AnalysisJobMetadata,
  AnalysisRecipe,
  AnalysisRepository,
  AnalysisResult,
  AnalysisResultSection,
  SaveAnalysisJobMetadataInput,
  SaveAnalysisResultInput,
  CreateAnalysisRecipeInput,
} from '../../contracts/index.js';
import { analyticsSqliteMigration001 } from '../../migrations/sqlite/index.js';
import { analyticsSqliteMigration002 } from '../../migrations/sqlite/002-result-lineage.js';
import { saveResultCollections, SqliteAnalysisResultReader } from './results.js';

type SqlRow = Record<string, unknown>;

export class SqliteAnalysisRepository implements AnalysisRepository {
  private readonly sqlite: Database.Database;

  constructor(filePath: string) {
    this.sqlite = new Database(filePath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
  }

  async migrate(): Promise<void> {
    for (const [migrationId, sql] of [
      ['001-initial', analyticsSqliteMigration001],
      ['002-result-lineage', analyticsSqliteMigration002],
    ] as const) {
      const checksum = sha256(sql);
      const existing = this.sqlite
        .prepare('SELECT checksum FROM plugin_migrations WHERE plugin_id=? AND migration_id=?')
        .get('analytics', migrationId) as SqlRow | undefined;
      if (existing) {
        if (existing.checksum !== checksum) {
          throw new Error(`Migration checksum mismatch for analytics:${migrationId}`);
        }
        continue;
      }
      const started = performance.now();
      this.sqlite.transaction(() => {
        this.sqlite.exec(sql);
        this.sqlite
          .prepare(
            `INSERT INTO plugin_migrations(
             plugin_id,migration_id,plugin_version,checksum,executed_at,duration_ms,result
           ) VALUES ('analytics',?,'1.0.0',?,?,?,'succeeded')`,
          )
          .run(
            migrationId,
            checksum,
            new Date().toISOString(),
            Math.max(0, Math.round(performance.now() - started)),
          );
      })();
    }
  }

  async close(): Promise<void> {
    if (this.sqlite.open) this.sqlite.close();
  }

  async listRecipes(cursor?: string, limit = 100) {
    const pageSize = Math.min(Math.max(limit, 1), 200);
    const decoded = cursor ? decodeCursor(cursor) : undefined;
    const rows = decoded
      ? (this.sqlite
          .prepare(
            `SELECT * FROM analysis_recipes WHERE (created_at<? OR (created_at=? AND id<?))
             ORDER BY created_at DESC,id DESC LIMIT ?`,
          )
          .all(decoded.createdAt, decoded.createdAt, decoded.id, pageSize + 1) as SqlRow[])
      : (this.sqlite
          .prepare('SELECT * FROM analysis_recipes ORDER BY created_at DESC,id DESC LIMIT ?')
          .all(pageSize + 1) as SqlRow[]);
    const items = rows.slice(0, pageSize).map(recipeRow);
    return {
      items,
      nextCursor:
        rows.length > pageSize ? encodeCursor(items.at(-1)!.createdAt, items.at(-1)!.id) : null,
    };
  }

  async getRecipe(id: string): Promise<AnalysisRecipe | null> {
    const row = this.sqlite.prepare('SELECT * FROM analysis_recipes WHERE id=?').get(id) as
      SqlRow | undefined;
    return row ? recipeRow(row) : null;
  }

  async createRecipe(input: CreateAnalysisRecipeInput): Promise<AnalysisRecipe> {
    return this.sqlite.transaction(() => {
      const id = randomUUID();
      const timestamp = new Date().toISOString();
      this.sqlite
        .prepare(
          `INSERT INTO analysis_recipes(
             id,name,dataset_id,method_id,method_version,parameters,revision,created_at,updated_at
           ) VALUES (?,?,?,?,?,?,1,?,?)`,
        )
        .run(
          id,
          input.name,
          input.datasetId,
          input.methodId,
          input.methodVersion,
          JSON.stringify(input.parameters),
          timestamp,
          timestamp,
        );
      appendEvent(this.sqlite, 'analysis.recipe.created', 'analysis-recipe', id, { revision: 1 });
      return recipeRow(
        this.sqlite.prepare('SELECT * FROM analysis_recipes WHERE id=?').get(id) as SqlRow,
      );
    })();
  }

  async updateRecipe(
    id: string,
    expectedRevision: number,
    input: CreateAnalysisRecipeInput,
  ): Promise<AnalysisRecipe | 'revision-conflict' | null> {
    return this.sqlite.transaction(() => {
      const current = this.sqlite
        .prepare('SELECT revision FROM analysis_recipes WHERE id=?')
        .get(id) as SqlRow | undefined;
      if (!current) return null;
      if (Number(current.revision) !== expectedRevision) return 'revision-conflict';
      const result = this.sqlite
        .prepare(
          `UPDATE analysis_recipes SET
             name=?,dataset_id=?,method_id=?,method_version=?,parameters=?,revision=revision+1,
             updated_at=? WHERE id=? AND revision=?`,
        )
        .run(
          input.name,
          input.datasetId,
          input.methodId,
          input.methodVersion,
          JSON.stringify(input.parameters),
          new Date().toISOString(),
          id,
          expectedRevision,
        );
      if (result.changes !== 1) return 'revision-conflict';
      const updated = recipeRow(
        this.sqlite.prepare('SELECT * FROM analysis_recipes WHERE id=?').get(id) as SqlRow,
      );
      appendEvent(this.sqlite, 'analysis.recipe.updated', 'analysis-recipe', id, {
        revision: updated.revision,
      });
      return updated;
    })();
  }

  async deleteRecipe(id: string, expectedRevision: number): Promise<boolean | 'revision-conflict'> {
    return this.sqlite.transaction(() => {
      const current = this.sqlite
        .prepare('SELECT revision FROM analysis_recipes WHERE id=?')
        .get(id) as SqlRow | undefined;
      if (!current) return false;
      if (Number(current.revision) !== expectedRevision) return 'revision-conflict';
      const result = this.sqlite
        .prepare('DELETE FROM analysis_recipes WHERE id=? AND revision=?')
        .run(id, expectedRevision);
      if (result.changes !== 1) return 'revision-conflict';
      appendEvent(this.sqlite, 'analysis.recipe.deleted', 'analysis-recipe', id, {});
      return true;
    })();
  }

  async createJobMetadata(
    id: string,
    input: SaveAnalysisJobMetadataInput,
  ): Promise<AnalysisJobMetadata> {
    return this.sqlite.transaction(() => {
      const timestamp = new Date().toISOString();
      this.sqlite
        .prepare(
          `INSERT INTO analysis_jobs(
             id,recipe_id,dataset_id,snapshot_id,method_id,method_version,parameters,sampling,
             result_id,created_at,started_at,completed_at,provenance
           ) VALUES (?,?,?,?,?,?,?,'{"applied":false,"inputRows":0,"sampleRows":0,"seed":null}',NULL,?,NULL,NULL,?)`,
        )
        .run(
          id,
          input.recipeId ?? null,
          input.datasetId,
          input.snapshotId,
          input.methodId,
          input.methodVersion,
          JSON.stringify(input.parameters),
          timestamp,
          input.provenance == null ? null : JSON.stringify(input.provenance),
        );
      appendEvent(this.sqlite, 'analysis.job.created', 'analysis-job', id, {
        datasetId: input.datasetId,
        snapshotId: input.snapshotId,
        methodId: input.methodId,
        methodVersion: input.methodVersion,
      });
      return jobRow(
        this.sqlite.prepare('SELECT * FROM analysis_jobs WHERE id=?').get(id) as SqlRow,
      );
    })();
  }

  async getJobMetadata(id: string): Promise<AnalysisJobMetadata | null> {
    const row = this.sqlite.prepare('SELECT * FROM analysis_jobs WHERE id=?').get(id) as
      SqlRow | undefined;
    return row ? jobRow(row) : null;
  }

  async listJobMetadata(limit = 100): Promise<AnalysisJobMetadata[]> {
    return (
      this.sqlite
        .prepare('SELECT * FROM analysis_jobs ORDER BY created_at DESC,id DESC LIMIT ?')
        .all(Math.min(Math.max(limit, 1), 1000)) as SqlRow[]
    ).map(jobRow);
  }

  async markJobStarted(id: string): Promise<void> {
    this.sqlite.transaction(() => {
      const timestamp = new Date().toISOString();
      const result = this.sqlite
        .prepare('UPDATE analysis_jobs SET started_at=COALESCE(started_at,?) WHERE id=?')
        .run(timestamp, id);
      if (result.changes !== 1) throw new Error(`Analysis Job not found: ${id}`);
      appendEvent(this.sqlite, 'analysis.job.started', 'analysis-job', id, {});
    })();
  }

  async saveResult(input: SaveAnalysisResultInput): Promise<AnalysisResult> {
    return this.sqlite.transaction(() => {
      const existing = this.sqlite
        .prepare('SELECT id FROM analysis_results WHERE job_id=?')
        .get(input.jobId) as SqlRow | undefined;
      if (existing) return resultRow(this.sqlite, String(existing.id));
      const id = randomUUID();
      const timestamp = new Date().toISOString();
      const metadata = this.sqlite
        .prepare(
          'SELECT parameters,provenance,dataset_id,snapshot_id,method_id,method_version FROM analysis_jobs WHERE id=?',
        )
        .get(input.jobId) as SqlRow | undefined;
      if (!metadata) throw new Error('Analysis Job metadata was not found');
      if (
        metadata.dataset_id !== input.datasetId ||
        metadata.snapshot_id !== input.snapshotId ||
        metadata.method_id !== input.methodId ||
        metadata.method_version !== input.methodVersion
      )
        throw new AnalysisResultQueryError(
          'INVALID_WORKER_RESULT',
          'Result input and method must match the frozen Job',
        );
      this.sqlite
        .prepare(
          `INSERT INTO analysis_results(
             id,job_id,dataset_id,snapshot_id,method_id,method_version,summary,metrics,tables_data,
             series_data,warnings,sampling,worker_version,created_at,parameters,provenance
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.jobId,
          input.datasetId,
          input.snapshotId,
          input.methodId,
          input.methodVersion,
          JSON.stringify(input.summary),
          JSON.stringify(input.metrics),
          JSON.stringify(input.tables),
          JSON.stringify(input.series),
          JSON.stringify(input.warnings),
          JSON.stringify(input.sampling),
          input.workerVersion,
          timestamp,
          metadata.parameters,
          metadata.provenance,
        );
      saveResultCollections(this.sqlite, id, input);
      const artifactInsert = this.sqlite.prepare(
        `INSERT INTO analysis_artifacts(result_id,artifact_id,kind,content_type,filename)
         VALUES (?,?,?,?,?)`,
      );
      for (const artifact of input.artifacts) {
        artifactInsert.run(id, artifact.id, artifact.kind, artifact.contentType, artifact.filename);
      }
      this.sqlite
        .prepare(
          'UPDATE analysis_jobs SET result_id=?,sampling=?,completed_at=? WHERE id=? AND result_id IS NULL',
        )
        .run(id, JSON.stringify(input.sampling), timestamp, input.jobId);
      appendEvent(this.sqlite, 'analysis.job.succeeded', 'analysis-job', input.jobId, {
        resultId: id,
      });
      return resultRow(this.sqlite, id);
    })();
  }

  async markJobFailed(id: string, code: string): Promise<void> {
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare('UPDATE analysis_jobs SET completed_at=? WHERE id=?')
        .run(new Date().toISOString(), id);
      appendEvent(this.sqlite, 'analysis.job.failed', 'analysis-job', id, { code });
    })();
  }

  async markJobCanceled(id: string): Promise<void> {
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare('UPDATE analysis_jobs SET completed_at=? WHERE id=?')
        .run(new Date().toISOString(), id);
      appendEvent(this.sqlite, 'analysis.job.canceled', 'analysis-job', id, {});
    })();
  }

  async getResult(id: string): Promise<AnalysisResult | null> {
    const exists = this.sqlite.prepare('SELECT 1 FROM analysis_results WHERE id=?').get(id);
    return exists ? resultRow(this.sqlite, id) : null;
  }
  async getResultPreview(id: string, limit = 20): Promise<AnalysisResult | null> {
    return new SqliteAnalysisResultReader(this.sqlite).preview(id, limit);
  }
  async getResultPage(
    id: string,
    section: AnalysisResultSection,
    collectionId: string,
    limit = 50,
    cursor?: string,
  ) {
    return new SqliteAnalysisResultReader(this.sqlite).page(
      id,
      section,
      collectionId,
      limit,
      cursor,
    );
  }
}

function recipeRow(row: SqlRow): AnalysisRecipe {
  return {
    id: String(row.id),
    name: String(row.name),
    datasetId: String(row.dataset_id),
    methodId: String(row.method_id),
    methodVersion: String(row.method_version),
    parameters: objectValue(row.parameters),
    revision: Number(row.revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function jobRow(row: SqlRow): AnalysisJobMetadata {
  return {
    id: String(row.id),
    recipeId: row.recipe_id == null ? null : String(row.recipe_id),
    datasetId: String(row.dataset_id),
    snapshotId: String(row.snapshot_id),
    methodId: String(row.method_id),
    methodVersion: String(row.method_version),
    parameters: objectValue(row.parameters),
    sampling: objectValue(row.sampling) as unknown as AnalysisJobMetadata['sampling'],
    provenance:
      row.provenance == null
        ? null
        : (objectValue(row.provenance) as unknown as NonNullable<
            AnalysisJobMetadata['provenance']
          >),
    resultId: row.result_id == null ? null : String(row.result_id),
    createdAt: String(row.created_at),
    startedAt: row.started_at == null ? null : String(row.started_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
  };
}

function resultRow(sqlite: Database.Database, id: string): AnalysisResult {
  const row = sqlite.prepare('SELECT * FROM analysis_results WHERE id=?').get(id) as SqlRow;
  const artifacts = sqlite
    .prepare('SELECT * FROM analysis_artifacts WHERE result_id=? ORDER BY artifact_id')
    .all(id) as SqlRow[];
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    state: 'succeeded',
    datasetId: String(row.dataset_id),
    snapshotId: String(row.snapshot_id),
    methodId: String(row.method_id),
    methodVersion: String(row.method_version),
    summary: objectValue(row.summary),
    parameters: objectValue(row.parameters),
    provenance:
      row.provenance == null
        ? null
        : (objectValue(row.provenance) as unknown as NonNullable<AnalysisResult['provenance']>),
    metrics: objectValue(row.metrics),
    tables: arrayValue(row.tables_data) as unknown as AnalysisResult['tables'],
    series: arrayValue(row.series_data) as unknown as AnalysisResult['series'],
    artifacts: artifacts.map(artifactRow),
    warnings: arrayValue(row.warnings).map(String),
    sampling: objectValue(row.sampling) as unknown as AnalysisResult['sampling'],
    workerVersion: String(row.worker_version),
    createdAt: String(row.created_at),
  };
}

function artifactRow(row: SqlRow): AnalysisArtifactRef {
  return {
    id: String(row.artifact_id),
    kind: String(row.kind),
    contentType: String(row.content_type),
    filename: String(row.filename),
  };
}

function appendEvent(
  sqlite: Database.Database,
  type: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
): void {
  sqlite
    .prepare(
      `INSERT INTO platform_events(
         id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
       ) VALUES (?,?,1,'analytics',?,?,?,?)`,
    )
    .run(
      randomUUID(),
      type,
      aggregateType,
      aggregateId,
      JSON.stringify(payload),
      new Date().toISOString(),
    );
}

function objectValue(value: unknown): Record<string, unknown> {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed : [];
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id })).toString('base64url');
}

function decodeCursor(value: string): { createdAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') throw new Error();
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new Error('Invalid Analysis cursor');
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
