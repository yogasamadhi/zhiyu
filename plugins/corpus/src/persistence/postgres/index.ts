import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type {
  Corpus,
  CorpusArtifactRef,
  CorpusBuildMetadata,
  CorpusRecipe,
  CorpusRepository,
  CorpusVersion,
  CreateCorpusInput,
  CreateCorpusRecipeInput,
} from '../../contracts/index.js';
import { corpusPostgresMigration001 } from '../../migrations/postgres/index.js';

type PgRow = Record<string, unknown>;
type PostgresClient = ReturnType<typeof postgres>;
type QueryClient = postgres.Sql | postgres.TransactionSql;
const MIGRATION_ID = '001-initial';

export class PostgresCorpusRepository implements CorpusRepository {
  private readonly sql: PostgresClient;

  constructor(connectionString: string, maxConnections = 5) {
    this.sql = postgres(connectionString, { max: maxConnections });
  }

  async migrate(): Promise<void> {
    const checksum = sha256(corpusPostgresMigration001);
    const rows = await this.sql`
      SELECT checksum FROM plugin_migrations
      WHERE plugin_id='corpus' AND migration_id=${MIGRATION_ID}
    `;
    if (rows[0]) {
      if (rows[0].checksum !== checksum) {
        throw new Error('Migration checksum mismatch for corpus:001-initial');
      }
      return;
    }
    const started = performance.now();
    await this.sql.begin(async (transaction) => {
      await transaction.unsafe(corpusPostgresMigration001);
      await transaction`
        INSERT INTO plugin_migrations(
          plugin_id,migration_id,plugin_version,checksum,executed_at,duration_ms,result
        ) VALUES (
          'corpus',${MIGRATION_ID},'1.0.0',${checksum},${new Date()},
          ${Math.max(0, Math.round(performance.now() - started))},'succeeded'
        )
      `;
    });
  }

  async close(): Promise<void> {
    await this.sql.end();
  }

  async listCorpora(cursor?: string, limit = 100) {
    const pageSize = Math.min(Math.max(limit, 1), 200);
    const decoded = cursor ? decodeCursor(cursor) : undefined;
    const rows = decoded
      ? await this.sql`
          SELECT * FROM corpora
          WHERE (created_at<${decoded.createdAt} OR (created_at=${decoded.createdAt} AND id<${decoded.id}))
          ORDER BY created_at DESC,id DESC LIMIT ${pageSize + 1}
        `
      : await this.sql`
          SELECT * FROM corpora ORDER BY created_at DESC,id DESC LIMIT ${pageSize + 1}
        `;
    const items = rows.slice(0, pageSize).map((row) => corpusRow(row as PgRow));
    return {
      items,
      nextCursor:
        rows.length > pageSize ? encodeCursor(items.at(-1)!.createdAt, items.at(-1)!.id) : null,
    };
  }

  async getCorpus(id: string): Promise<Corpus | null> {
    const rows = await this.sql`SELECT * FROM corpora WHERE id=${id}`;
    return rows[0] ? corpusRow(rows[0] as PgRow) : null;
  }

  async createCorpus(input: CreateCorpusInput): Promise<Corpus> {
    return this.sql.begin(async (transaction) => {
      const id = randomUUID();
      const timestamp = new Date();
      const rows = await transaction`
        INSERT INTO corpora(id,name,dataset_id,revision,created_at,updated_at)
        VALUES (${id},${input.name},${input.datasetId},1,${timestamp},${timestamp}) RETURNING *
      `;
      await appendEvent(transaction, 'corpus.created', 'corpus', id, {
        datasetId: input.datasetId,
      });
      return corpusRow(rows[0] as PgRow);
    });
  }

  async updateCorpus(
    id: string,
    expectedRevision: number,
    input: CreateCorpusInput,
  ): Promise<Corpus | 'revision-conflict' | null> {
    return this.sql.begin(async (transaction) => {
      const selected = await transaction`SELECT revision FROM corpora WHERE id=${id} FOR UPDATE`;
      if (!selected[0]) return null;
      if (Number(selected[0].revision) !== expectedRevision) return 'revision-conflict';
      const rows = await transaction`
        UPDATE corpora SET name=${input.name},dataset_id=${input.datasetId},
          revision=revision+1,updated_at=${new Date()}
        WHERE id=${id} AND revision=${expectedRevision} RETURNING *
      `;
      if (!rows[0]) return 'revision-conflict';
      const corpus = corpusRow(rows[0] as PgRow);
      await appendEvent(transaction, 'corpus.updated', 'corpus', id, {
        revision: corpus.revision,
      });
      return corpus;
    });
  }

  async deleteCorpus(id: string, expectedRevision: number): Promise<boolean | 'revision-conflict'> {
    return this.sql.begin(async (transaction) => {
      const selected = await transaction`SELECT revision FROM corpora WHERE id=${id} FOR UPDATE`;
      if (!selected[0]) return false;
      if (Number(selected[0].revision) !== expectedRevision) return 'revision-conflict';
      const rows = await transaction`
        DELETE FROM corpora WHERE id=${id} AND revision=${expectedRevision} RETURNING id
      `;
      if (!rows[0]) return 'revision-conflict';
      await appendEvent(transaction, 'corpus.deleted', 'corpus', id, {});
      return true;
    });
  }

  async listRecipes(corpusId: string): Promise<CorpusRecipe[]> {
    const rows = await this.sql`
      SELECT * FROM corpus_recipes WHERE corpus_id=${corpusId} ORDER BY created_at DESC,id DESC
    `;
    return rows.map((row) => recipeRow(row as PgRow));
  }

  async getRecipe(id: string): Promise<CorpusRecipe | null> {
    const rows = await this.sql`SELECT * FROM corpus_recipes WHERE id=${id}`;
    return rows[0] ? recipeRow(rows[0] as PgRow) : null;
  }

  async createRecipe(corpusId: string, input: CreateCorpusRecipeInput): Promise<CorpusRecipe> {
    return this.sql.begin(async (transaction) => {
      const corpora = await transaction`SELECT dataset_id FROM corpora WHERE id=${corpusId}`;
      if (!corpora[0]) throw new Error(`Corpus not found: ${corpusId}`);
      const id = randomUUID();
      const timestamp = new Date();
      const rows = await transaction`
        INSERT INTO corpus_recipes(
          id,corpus_id,name,dataset_id,snapshot_policy,selected_text_fields,metadata_fields,
          strip_html,unicode_normalization,deduplication,near_duplicate_threshold,chunk_size,
          chunk_overlap,language_policy,output_formats,revision,created_at,updated_at
        ) VALUES (
          ${id},${corpusId},${input.name},${String(corpora[0].dataset_id)},
          ${transaction.json(jsonValue(input.snapshotPolicy))},
          ${transaction.json(jsonValue(input.selectedTextFields))},
          ${transaction.json(jsonValue(input.metadataFields))},${input.stripHtml},
          ${input.unicodeNormalization},${input.deduplication},${input.nearDuplicateThreshold},
          ${input.chunkSize},${input.chunkOverlap},${input.languagePolicy},
          ${transaction.json(jsonValue(input.outputFormats))},1,${timestamp},${timestamp}
        ) RETURNING *
      `;
      await appendEvent(transaction, 'corpus.recipe.created', 'corpus-recipe', id, { corpusId });
      return recipeRow(rows[0] as PgRow);
    });
  }

  async updateRecipe(
    corpusId: string,
    id: string,
    expectedRevision: number,
    input: CreateCorpusRecipeInput,
  ): Promise<CorpusRecipe | 'revision-conflict' | null> {
    return this.sql.begin(async (transaction) => {
      const selected = await transaction`
        SELECT revision FROM corpus_recipes WHERE id=${id} AND corpus_id=${corpusId} FOR UPDATE
      `;
      if (!selected[0]) return null;
      if (Number(selected[0].revision) !== expectedRevision) return 'revision-conflict';
      const rows = await transaction`
        UPDATE corpus_recipes SET name=${input.name},
          snapshot_policy=${transaction.json(jsonValue(input.snapshotPolicy))},
          selected_text_fields=${transaction.json(jsonValue(input.selectedTextFields))},
          metadata_fields=${transaction.json(jsonValue(input.metadataFields))},
          strip_html=${input.stripHtml},unicode_normalization=${input.unicodeNormalization},
          deduplication=${input.deduplication},
          near_duplicate_threshold=${input.nearDuplicateThreshold},chunk_size=${input.chunkSize},
          chunk_overlap=${input.chunkOverlap},language_policy=${input.languagePolicy},
          output_formats=${transaction.json(jsonValue(input.outputFormats))},revision=revision+1,
          updated_at=${new Date()}
        WHERE id=${id} AND corpus_id=${corpusId} AND revision=${expectedRevision} RETURNING *
      `;
      if (!rows[0]) return 'revision-conflict';
      const recipe = recipeRow(rows[0] as PgRow);
      await appendEvent(transaction, 'corpus.recipe.updated', 'corpus-recipe', id, {
        corpusId,
        revision: recipe.revision,
      });
      return recipe;
    });
  }

  async deleteRecipe(
    corpusId: string,
    id: string,
    expectedRevision: number,
  ): Promise<boolean | 'revision-conflict'> {
    return this.sql.begin(async (transaction) => {
      const selected = await transaction`
        SELECT revision FROM corpus_recipes WHERE id=${id} AND corpus_id=${corpusId} FOR UPDATE
      `;
      if (!selected[0]) return false;
      if (Number(selected[0].revision) !== expectedRevision) return 'revision-conflict';
      const rows = await transaction`
        DELETE FROM corpus_recipes
        WHERE id=${id} AND corpus_id=${corpusId} AND revision=${expectedRevision} RETURNING id
      `;
      if (!rows[0]) return 'revision-conflict';
      await appendEvent(transaction, 'corpus.recipe.deleted', 'corpus-recipe', id, { corpusId });
      return true;
    });
  }

  async createBuildMetadata(
    id: string,
    input: {
      corpusId: string;
      recipeId: string;
      recipeRevision: number;
      datasetId: string;
      snapshotId: string;
    },
  ): Promise<CorpusBuildMetadata> {
    return this.sql.begin(async (transaction) => {
      const timestamp = new Date();
      const rows = await transaction`
        INSERT INTO corpus_builds(
          id,corpus_id,recipe_id,recipe_revision,dataset_id,snapshot_id,version_id,created_at,
          started_at,completed_at
        ) VALUES (
          ${id},${input.corpusId},${input.recipeId},${input.recipeRevision},${input.datasetId},
          ${input.snapshotId},NULL,${timestamp},NULL,NULL
        ) RETURNING *
      `;
      await appendEvent(transaction, 'corpus.build.created', 'corpus-build', id, input);
      return buildRow(rows[0] as PgRow);
    });
  }

  async getBuildMetadata(id: string): Promise<CorpusBuildMetadata | null> {
    const rows = await this.sql`SELECT * FROM corpus_builds WHERE id=${id}`;
    return rows[0] ? buildRow(rows[0] as PgRow) : null;
  }

  async listBuildMetadata(corpusId?: string, limit = 100): Promise<CorpusBuildMetadata[]> {
    const pageSize = Math.min(Math.max(limit, 1), 1000);
    const rows = corpusId
      ? await this.sql`
          SELECT * FROM corpus_builds WHERE corpus_id=${corpusId}
          ORDER BY created_at DESC,id DESC LIMIT ${pageSize}
        `
      : await this.sql`
          SELECT * FROM corpus_builds ORDER BY created_at DESC,id DESC LIMIT ${pageSize}
        `;
    return rows.map((row) => buildRow(row as PgRow));
  }

  async markBuildStarted(id: string): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const rows = await transaction`
        UPDATE corpus_builds SET started_at=COALESCE(started_at,${new Date()})
        WHERE id=${id} RETURNING id
      `;
      if (!rows[0]) throw new Error(`Corpus Build not found: ${id}`);
      await appendEvent(transaction, 'corpus.build.started', 'corpus-build', id, {});
    });
  }

  async markBuildFailed(id: string, code: string): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`UPDATE corpus_builds SET completed_at=${new Date()} WHERE id=${id}`;
      await appendEvent(transaction, 'corpus.build.failed', 'corpus-build', id, { code });
    });
  }

  async markBuildCanceled(id: string): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`UPDATE corpus_builds SET completed_at=${new Date()} WHERE id=${id}`;
      await appendEvent(transaction, 'corpus.build.canceled', 'corpus-build', id, {});
    });
  }

  async saveVersion(input: Omit<CorpusVersion, 'id' | 'createdAt'>): Promise<CorpusVersion> {
    return this.sql.begin(async (transaction) => {
      const builds = await transaction`
        SELECT version_id FROM corpus_builds WHERE id=${input.buildId} FOR UPDATE
      `;
      if (builds[0]?.version_id) {
        return this.readVersion(transaction, String(builds[0].version_id));
      }
      const existing = await transaction`
        SELECT id FROM corpus_versions
        WHERE corpus_id=${input.corpusId} AND fingerprint=${input.fingerprint}
      `;
      if (existing[0]) {
        const id = String(existing[0].id);
        await transaction`
          UPDATE corpus_builds SET version_id=${id},completed_at=${new Date()}
          WHERE id=${input.buildId}
        `;
        return this.readVersion(transaction, id);
      }
      const id = randomUUID();
      const timestamp = new Date();
      await transaction`
        INSERT INTO corpus_versions(
          id,corpus_id,build_id,dataset_id,snapshot_id,snapshot_fingerprint,recipe_id,
          recipe_revision,fingerprint,worker_version,stats,created_at
        ) VALUES (
          ${id},${input.corpusId},${input.buildId},${input.datasetId},${input.snapshotId},
          ${input.snapshotFingerprint},${input.recipeId},${input.recipeRevision},${input.fingerprint},
          ${input.workerVersion},${transaction.json(jsonValue(input.stats))},${timestamp}
        )
      `;
      for (const artifact of input.artifacts) {
        await transaction`
          INSERT INTO corpus_artifacts(
            version_id,artifact_id,kind,content_type,filename,checksum,size
          ) VALUES (
            ${id},${artifact.id},${artifact.kind},${artifact.contentType},${artifact.filename},
            ${artifact.checksum},${artifact.size}
          )
        `;
      }
      await transaction`
        UPDATE corpus_builds SET version_id=${id},completed_at=${timestamp} WHERE id=${input.buildId}
      `;
      await appendEvent(transaction, 'corpus.version.created', 'corpus-version', id, {
        buildId: input.buildId,
        fingerprint: input.fingerprint,
      });
      return this.readVersion(transaction, id);
    });
  }

  async findVersion(corpusId: string, fingerprint: string): Promise<CorpusVersion | null> {
    const rows = await this.sql`
      SELECT id FROM corpus_versions WHERE corpus_id=${corpusId} AND fingerprint=${fingerprint}
    `;
    return rows[0] ? this.readVersion(this.sql, String(rows[0].id)) : null;
  }

  async getVersion(id: string): Promise<CorpusVersion | null> {
    const rows = await this.sql`SELECT id FROM corpus_versions WHERE id=${id}`;
    return rows[0] ? this.readVersion(this.sql, id) : null;
  }

  async listVersions(corpusId: string, limit = 100): Promise<CorpusVersion[]> {
    const rows = await this.sql`
      SELECT id FROM corpus_versions WHERE corpus_id=${corpusId}
      ORDER BY created_at DESC,id DESC LIMIT ${Math.min(Math.max(limit, 1), 1000)}
    `;
    return Promise.all(rows.map((row) => this.readVersion(this.sql, String(row.id))));
  }

  private async readVersion(sql: QueryClient, id: string): Promise<CorpusVersion> {
    const rows = await sql`SELECT * FROM corpus_versions WHERE id=${id}`;
    const artifacts = await sql`
      SELECT * FROM corpus_artifacts WHERE version_id=${id} ORDER BY artifact_id
    `;
    return versionRow(rows[0] as PgRow, artifacts as unknown as PgRow[]);
  }
}

function corpusRow(row: PgRow): Corpus {
  return {
    id: String(row.id),
    name: String(row.name),
    datasetId: String(row.dataset_id),
    revision: Number(row.revision),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function recipeRow(row: PgRow): CorpusRecipe {
  return {
    id: String(row.id),
    corpusId: String(row.corpus_id),
    name: String(row.name),
    datasetId: String(row.dataset_id),
    snapshotPolicy: objectValue(row.snapshot_policy) as unknown as CorpusRecipe['snapshotPolicy'],
    selectedTextFields: arrayValue(row.selected_text_fields).map(String),
    metadataFields: arrayValue(row.metadata_fields).map(String),
    stripHtml: Boolean(row.strip_html),
    unicodeNormalization: String(row.unicode_normalization) as CorpusRecipe['unicodeNormalization'],
    deduplication: String(row.deduplication) as CorpusRecipe['deduplication'],
    nearDuplicateThreshold: Number(row.near_duplicate_threshold),
    chunkSize: Number(row.chunk_size),
    chunkOverlap: Number(row.chunk_overlap),
    languagePolicy: String(row.language_policy) as CorpusRecipe['languagePolicy'],
    outputFormats: arrayValue(row.output_formats).map(String) as CorpusRecipe['outputFormats'],
    revision: Number(row.revision),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function buildRow(row: PgRow): CorpusBuildMetadata {
  return {
    id: String(row.id),
    corpusId: String(row.corpus_id),
    recipeId: String(row.recipe_id),
    recipeRevision: Number(row.recipe_revision),
    datasetId: String(row.dataset_id),
    snapshotId: String(row.snapshot_id),
    versionId: nullableString(row.version_id),
    createdAt: iso(row.created_at),
    startedAt: nullableIso(row.started_at),
    completedAt: nullableIso(row.completed_at),
  };
}

function versionRow(row: PgRow, artifacts: PgRow[]): CorpusVersion {
  return {
    id: String(row.id),
    corpusId: String(row.corpus_id),
    buildId: String(row.build_id),
    datasetId: String(row.dataset_id),
    snapshotId: String(row.snapshot_id),
    snapshotFingerprint: String(row.snapshot_fingerprint),
    recipeId: String(row.recipe_id),
    recipeRevision: Number(row.recipe_revision),
    fingerprint: String(row.fingerprint),
    workerVersion: String(row.worker_version),
    stats: objectValue(row.stats) as unknown as CorpusVersion['stats'],
    artifacts: artifacts.map(artifactRow),
    createdAt: iso(row.created_at),
  };
}

function artifactRow(row: PgRow): CorpusArtifactRef {
  return {
    id: String(row.artifact_id),
    kind: String(row.kind),
    contentType: String(row.content_type),
    filename: String(row.filename),
    checksum: String(row.checksum),
    size: Number(row.size),
  };
}

async function appendEvent(
  sql: QueryClient,
  type: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await sql`
    INSERT INTO platform_events(
      id,type,schema_version,producer_plugin_id,aggregate_type,aggregate_id,payload,occurred_at
    ) VALUES (
      ${randomUUID()},${type},1,'corpus',${aggregateType},${aggregateId},
      ${sql.json(jsonValue(payload))},${new Date()}
    )
  `;
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
    throw new Error('Invalid Corpus cursor');
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
