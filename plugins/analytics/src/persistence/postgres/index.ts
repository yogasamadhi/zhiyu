import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type {
  AnalysisArtifactRef,
  AnalysisJobMetadata,
  AnalysisRecipe,
  AnalysisRepository,
  AnalysisResult,
  CreateAnalysisJobInput,
  CreateAnalysisRecipeInput,
} from '../../contracts/index.js';
import { analyticsPostgresMigration001 } from '../../migrations/postgres/index.js';

type PgRow = Record<string, unknown>;
type PostgresClient = ReturnType<typeof postgres>;
const MIGRATION_ID = '001-initial';

export class PostgresAnalysisRepository implements AnalysisRepository {
  private readonly sql: PostgresClient;

  constructor(connectionString: string, maxConnections = 5) {
    this.sql = postgres(connectionString, { max: maxConnections });
  }

  async migrate(): Promise<void> {
    const checksum = sha256(analyticsPostgresMigration001);
    const rows = await this.sql`
      SELECT checksum FROM plugin_migrations
      WHERE plugin_id='analytics' AND migration_id=${MIGRATION_ID}
    `;
    if (rows[0]) {
      if (rows[0].checksum !== checksum) {
        throw new Error('Migration checksum mismatch for analytics:001-initial');
      }
      return;
    }
    const started = performance.now();
    await this.sql.begin(async (transaction) => {
      await transaction.unsafe(analyticsPostgresMigration001);
      await transaction`
        INSERT INTO plugin_migrations(
          plugin_id,migration_id,plugin_version,checksum,executed_at,duration_ms,result
        ) VALUES (
          'analytics',${MIGRATION_ID},'1.0.0',${checksum},${new Date()},
          ${Math.max(0, Math.round(performance.now() - started))},'succeeded'
        )
      `;
    });
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  async listRecipes(cursor?: string, limit = 100) {
    const pageSize = Math.min(Math.max(limit, 1), 200);
    const decoded = cursor ? decodeCursor(cursor) : undefined;
    const rows = decoded
      ? await this.sql`
          SELECT * FROM analysis_recipes
          WHERE (created_at<${decoded.createdAt} OR (created_at=${decoded.createdAt} AND id<${decoded.id}))
          ORDER BY created_at DESC,id DESC LIMIT ${pageSize + 1}
        `
      : await this.sql`
          SELECT * FROM analysis_recipes ORDER BY created_at DESC,id DESC LIMIT ${pageSize + 1}
        `;
    const items = rows.slice(0, pageSize).map((row) => recipeRow(row as PgRow));
    return {
      items,
      nextCursor:
        rows.length > pageSize ? encodeCursor(items.at(-1)!.createdAt, items.at(-1)!.id) : null,
    };
  }

  async getRecipe(id: string): Promise<AnalysisRecipe | null> {
    const rows = await this.sql`SELECT * FROM analysis_recipes WHERE id=${id}`;
    return rows[0] ? recipeRow(rows[0] as PgRow) : null;
  }

  async createRecipe(input: CreateAnalysisRecipeInput): Promise<AnalysisRecipe> {
    return this.sql.begin(async (transaction) => {
      const id = randomUUID();
      const timestamp = new Date();
      const rows = await transaction`
        INSERT INTO analysis_recipes(
          id,name,dataset_id,method_id,method_version,parameters,revision,created_at,updated_at
        ) VALUES (
          ${id},${input.name},${input.datasetId},${input.methodId},${input.methodVersion},
          ${transaction.json(jsonValue(input.parameters))},1,${timestamp},${timestamp}
        ) RETURNING *
      `;
      await transaction`
        INSERT INTO platform_events(
          id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
        ) VALUES (
          ${randomUUID()},'analysis.recipe.created',1,'analytics','analysis-recipe',${id},
          ${transaction.json(jsonValue({ revision: 1 }))},${timestamp}
        )
      `;
      return recipeRow(rows[0] as PgRow);
    });
  }

  async updateRecipe(
    id: string,
    expectedRevision: number,
    input: CreateAnalysisRecipeInput,
  ): Promise<AnalysisRecipe | 'revision-conflict' | null> {
    return this.sql.begin(async (transaction) => {
      const selected = await transaction`
        SELECT revision FROM analysis_recipes WHERE id=${id} FOR UPDATE
      `;
      if (!selected[0]) return null;
      if (Number(selected[0].revision) !== expectedRevision) return 'revision-conflict';
      const rows = await transaction`
        UPDATE analysis_recipes SET
          name=${input.name},dataset_id=${input.datasetId},method_id=${input.methodId},
          method_version=${input.methodVersion},parameters=${transaction.json(
            jsonValue(input.parameters),
          )},revision=revision+1,updated_at=${new Date()}
        WHERE id=${id} AND revision=${expectedRevision} RETURNING *
      `;
      if (!rows[0]) return 'revision-conflict';
      const updated = recipeRow(rows[0] as PgRow);
      await transaction`
        INSERT INTO platform_events(
          id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
        ) VALUES (
          ${randomUUID()},'analysis.recipe.updated',1,'analytics','analysis-recipe',${id},
          ${transaction.json(jsonValue({ revision: updated.revision }))},${new Date()}
        )
      `;
      return updated;
    });
  }

  async deleteRecipe(id: string, expectedRevision: number): Promise<boolean | 'revision-conflict'> {
    return this.sql.begin(async (transaction) => {
      const selected = await transaction`
        SELECT revision FROM analysis_recipes WHERE id=${id} FOR UPDATE
      `;
      if (!selected[0]) return false;
      if (Number(selected[0].revision) !== expectedRevision) return 'revision-conflict';
      const rows = await transaction`
        DELETE FROM analysis_recipes WHERE id=${id} AND revision=${expectedRevision} RETURNING id
      `;
      if (!rows[0]) return 'revision-conflict';
      await transaction`
        INSERT INTO platform_events(
          id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
        ) VALUES (
          ${randomUUID()},'analysis.recipe.deleted',1,'analytics','analysis-recipe',${id},
          ${transaction.json(jsonValue({}))},${new Date()}
        )
      `;
      return true;
    });
  }

  async createJobMetadata(id: string, input: CreateAnalysisJobInput): Promise<AnalysisJobMetadata> {
    return this.sql.begin(async (transaction) => {
      const timestamp = new Date();
      const sampling = { applied: false, inputRows: 0, sampleRows: 0, seed: null };
      const rows = await transaction`
        INSERT INTO analysis_jobs(
          id,recipe_id,dataset_id,snapshot_id,method_id,method_version,parameters,sampling,
          result_id,created_at,started_at,completed_at
        ) VALUES (
          ${id},${input.recipeId ?? null},${input.datasetId},${input.snapshotId},${input.methodId},
          ${input.methodVersion},${transaction.json(jsonValue(input.parameters))},
          ${transaction.json(jsonValue(sampling))},NULL,${timestamp},NULL,NULL
        ) RETURNING *
      `;
      await transaction`
        INSERT INTO platform_events(
          id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
        ) VALUES (
          ${randomUUID()},'analysis.job.created',1,'analytics','analysis-job',${id},
          ${transaction.json(
            jsonValue({
              datasetId: input.datasetId,
              snapshotId: input.snapshotId,
              methodId: input.methodId,
              methodVersion: input.methodVersion,
            }),
          )},${timestamp}
        )
      `;
      return jobRow(rows[0] as PgRow);
    });
  }

  async getJobMetadata(id: string): Promise<AnalysisJobMetadata | null> {
    const rows = await this.sql`SELECT * FROM analysis_jobs WHERE id=${id}`;
    return rows[0] ? jobRow(rows[0] as PgRow) : null;
  }

  async listJobMetadata(limit = 100): Promise<AnalysisJobMetadata[]> {
    const rows = await this.sql`
      SELECT * FROM analysis_jobs ORDER BY created_at DESC,id DESC
      LIMIT ${Math.min(Math.max(limit, 1), 1000)}
    `;
    return rows.map((row) => jobRow(row as PgRow));
  }

  async markJobStarted(id: string): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const rows = await transaction`
        UPDATE analysis_jobs SET started_at=COALESCE(started_at,${new Date()})
        WHERE id=${id} RETURNING id
      `;
      if (!rows[0]) throw new Error(`Analysis Job not found: ${id}`);
      await transaction`
        INSERT INTO platform_events(
          id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
        ) VALUES (
          ${randomUUID()},'analysis.job.started',1,'analytics','analysis-job',${id},
          ${transaction.json(jsonValue({}))},${new Date()}
        )
      `;
    });
  }

  async saveResult(input: Omit<AnalysisResult, 'id' | 'createdAt'>): Promise<AnalysisResult> {
    return this.sql.begin(async (transaction) => {
      const existing = await transaction`
        SELECT id FROM analysis_results WHERE job_id=${input.jobId}
      `;
      if (existing[0]) {
        const existingId = String(existing[0].id);
        const results = await transaction`SELECT * FROM analysis_results WHERE id=${existingId}`;
        const artifacts = await transaction`
          SELECT * FROM analysis_artifacts WHERE result_id=${existingId} ORDER BY artifact_id
        `;
        return resultRow(results[0] as PgRow, artifacts as unknown as PgRow[]);
      }
      const id = randomUUID();
      const timestamp = new Date();
      await transaction`
        INSERT INTO analysis_results(
          id,job_id,dataset_id,snapshot_id,method_id,method_version,summary,metrics,tables_data,
          series_data,warnings,sampling,worker_version,created_at
        ) VALUES (
          ${id},${input.jobId},${input.datasetId},${input.snapshotId},${input.methodId},
          ${input.methodVersion},${transaction.json(jsonValue(input.summary))},
          ${transaction.json(jsonValue(input.metrics))},${transaction.json(jsonValue(input.tables))},
          ${transaction.json(jsonValue(input.series))},${transaction.json(jsonValue(input.warnings))},
          ${transaction.json(jsonValue(input.sampling))},${input.workerVersion},${timestamp}
        )
      `;
      for (const artifact of input.artifacts) {
        await transaction`
          INSERT INTO analysis_artifacts(result_id,artifact_id,kind,content_type,filename)
          VALUES (${id},${artifact.id},${artifact.kind},${artifact.contentType},${artifact.filename})
        `;
      }
      await transaction`
        UPDATE analysis_jobs SET result_id=${id},sampling=${transaction.json(
          jsonValue(input.sampling),
        )},completed_at=${timestamp} WHERE id=${input.jobId} AND result_id IS NULL
      `;
      await transaction`
        INSERT INTO platform_events(
          id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
        ) VALUES (
          ${randomUUID()},'analysis.job.succeeded',1,'analytics','analysis-job',${input.jobId},
          ${transaction.json(jsonValue({ resultId: id }))},${timestamp}
        )
      `;
      return {
        id,
        ...input,
        createdAt: timestamp.toISOString(),
      };
    });
  }

  async markJobFailed(id: string, code: string): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`UPDATE analysis_jobs SET completed_at=${new Date()} WHERE id=${id}`;
      await transaction`
        INSERT INTO platform_events(
          id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
        ) VALUES (
          ${randomUUID()},'analysis.job.failed',1,'analytics','analysis-job',${id},
          ${transaction.json(jsonValue({ code }))},${new Date()}
        )
      `;
    });
  }

  async markJobCanceled(id: string): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`UPDATE analysis_jobs SET completed_at=${new Date()} WHERE id=${id}`;
      await transaction`
        INSERT INTO platform_events(
          id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
        ) VALUES (
          ${randomUUID()},'analysis.job.canceled',1,'analytics','analysis-job',${id},
          ${transaction.json(jsonValue({}))},${new Date()}
        )
      `;
    });
  }

  async getResult(id: string): Promise<AnalysisResult | null> {
    const rows = await this.sql`SELECT * FROM analysis_results WHERE id=${id}`;
    if (!rows[0]) return null;
    const artifacts = await this.sql`
      SELECT * FROM analysis_artifacts WHERE result_id=${id} ORDER BY artifact_id
    `;
    return resultRow(rows[0] as PgRow, artifacts as unknown as PgRow[]);
  }
}

function recipeRow(row: PgRow): AnalysisRecipe {
  return {
    id: String(row.id),
    name: String(row.name),
    datasetId: String(row.dataset_id),
    methodId: String(row.method_id),
    methodVersion: String(row.method_version),
    parameters: objectValue(row.parameters),
    revision: Number(row.revision),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function jobRow(row: PgRow): AnalysisJobMetadata {
  return {
    id: String(row.id),
    recipeId: nullableString(row.recipe_id),
    datasetId: String(row.dataset_id),
    snapshotId: String(row.snapshot_id),
    methodId: String(row.method_id),
    methodVersion: String(row.method_version),
    parameters: objectValue(row.parameters),
    sampling: objectValue(row.sampling) as unknown as AnalysisJobMetadata['sampling'],
    resultId: nullableString(row.result_id),
    createdAt: iso(row.created_at),
    startedAt: nullableIso(row.started_at),
    completedAt: nullableIso(row.completed_at),
  };
}

function resultRow(row: PgRow, artifacts: PgRow[]): AnalysisResult {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    datasetId: String(row.dataset_id),
    snapshotId: String(row.snapshot_id),
    methodId: String(row.method_id),
    methodVersion: String(row.method_version),
    summary: objectValue(row.summary),
    metrics: objectValue(row.metrics),
    tables: arrayValue(row.tables_data) as unknown as AnalysisResult['tables'],
    series: arrayValue(row.series_data) as unknown as AnalysisResult['series'],
    artifacts: artifacts.map(artifactRow),
    warnings: arrayValue(row.warnings).map(String),
    sampling: objectValue(row.sampling) as unknown as AnalysisResult['sampling'],
    workerVersion: String(row.worker_version),
    createdAt: iso(row.created_at),
  };
}

function artifactRow(row: PgRow): AnalysisArtifactRef {
  return {
    id: String(row.artifact_id),
    kind: String(row.kind),
    contentType: String(row.content_type),
    filename: String(row.filename),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function nullableIso(value: unknown): string | null {
  return value == null ? null : iso(value);
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id })).toString('base64url');
}

function decodeCursor(value: string): { createdAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') throw new Error();
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new Error('Invalid Analysis cursor');
  }
}

function jsonValue(value: unknown): Parameters<PostgresClient['json']>[0] {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('Value is not JSON serializable');
  return JSON.parse(serialized) as Parameters<PostgresClient['json']>[0];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
