import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
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
import { corpusSqliteMigration001 } from '../../migrations/sqlite/index.js';

type SqlRow = Record<string, unknown>;
const MIGRATION_ID = '001-initial';

export class SqliteCorpusRepository implements CorpusRepository {
  private readonly sqlite: Database.Database;

  constructor(filePath: string) {
    this.sqlite = new Database(filePath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
  }

  async migrate(): Promise<void> {
    const checksum = sha256(corpusSqliteMigration001);
    const existing = this.sqlite
      .prepare('SELECT checksum FROM plugin_migrations WHERE plugin_id=? AND migration_id=?')
      .get('corpus', MIGRATION_ID) as SqlRow | undefined;
    if (existing) {
      if (existing.checksum !== checksum) {
        throw new Error('Migration checksum mismatch for corpus:001-initial');
      }
      return;
    }
    const started = performance.now();
    this.sqlite.transaction(() => {
      this.sqlite.exec(corpusSqliteMigration001);
      this.sqlite
        .prepare(
          `INSERT INTO plugin_migrations(
             plugin_id,migration_id,plugin_version,checksum,executed_at,duration_ms,result
           ) VALUES ('corpus',?,'1.0.0',?,?,?,'succeeded')`,
        )
        .run(
          MIGRATION_ID,
          checksum,
          new Date().toISOString(),
          Math.max(0, Math.round(performance.now() - started)),
        );
    })();
  }

  async close(): Promise<void> {
    if (this.sqlite.open) this.sqlite.close();
  }

  async listCorpora(cursor?: string, limit = 100) {
    const pageSize = Math.min(Math.max(limit, 1), 200);
    const decoded = cursor ? decodeCursor(cursor) : undefined;
    const rows = decoded
      ? (this.sqlite
          .prepare(
            `SELECT * FROM corpora WHERE (created_at<? OR (created_at=? AND id<?))
             ORDER BY created_at DESC,id DESC LIMIT ?`,
          )
          .all(decoded.createdAt, decoded.createdAt, decoded.id, pageSize + 1) as SqlRow[])
      : (this.sqlite
          .prepare('SELECT * FROM corpora ORDER BY created_at DESC,id DESC LIMIT ?')
          .all(pageSize + 1) as SqlRow[]);
    const items = rows.slice(0, pageSize).map(corpusRow);
    return {
      items,
      nextCursor:
        rows.length > pageSize ? encodeCursor(items.at(-1)!.createdAt, items.at(-1)!.id) : null,
    };
  }

  async getCorpus(id: string): Promise<Corpus | null> {
    const row = this.sqlite.prepare('SELECT * FROM corpora WHERE id=?').get(id) as
      SqlRow | undefined;
    return row ? corpusRow(row) : null;
  }

  async createCorpus(input: CreateCorpusInput): Promise<Corpus> {
    return this.sqlite.transaction(() => {
      const id = randomUUID();
      const timestamp = new Date().toISOString();
      this.sqlite
        .prepare(
          `INSERT INTO corpora(id,name,dataset_id,revision,created_at,updated_at)
           VALUES (?,?,?,1,?,?)`,
        )
        .run(id, input.name, input.datasetId, timestamp, timestamp);
      appendEvent(this.sqlite, 'corpus.created', 'corpus', id, { datasetId: input.datasetId });
      return corpusRow(this.sqlite.prepare('SELECT * FROM corpora WHERE id=?').get(id) as SqlRow);
    })();
  }

  async updateCorpus(
    id: string,
    expectedRevision: number,
    input: CreateCorpusInput,
  ): Promise<Corpus | 'revision-conflict' | null> {
    return this.sqlite.transaction(() => {
      const current = this.sqlite.prepare('SELECT revision FROM corpora WHERE id=?').get(id) as
        SqlRow | undefined;
      if (!current) return null;
      if (Number(current.revision) !== expectedRevision) return 'revision-conflict';
      const updated = this.sqlite
        .prepare(
          `UPDATE corpora SET name=?,dataset_id=?,revision=revision+1,updated_at=?
           WHERE id=? AND revision=?`,
        )
        .run(input.name, input.datasetId, new Date().toISOString(), id, expectedRevision);
      if (updated.changes !== 1) return 'revision-conflict';
      const corpus = corpusRow(
        this.sqlite.prepare('SELECT * FROM corpora WHERE id=?').get(id) as SqlRow,
      );
      appendEvent(this.sqlite, 'corpus.updated', 'corpus', id, { revision: corpus.revision });
      return corpus;
    })();
  }

  async deleteCorpus(id: string, expectedRevision: number): Promise<boolean | 'revision-conflict'> {
    return this.sqlite.transaction(() => {
      const current = this.sqlite.prepare('SELECT revision FROM corpora WHERE id=?').get(id) as
        SqlRow | undefined;
      if (!current) return false;
      if (Number(current.revision) !== expectedRevision) return 'revision-conflict';
      const deleted = this.sqlite
        .prepare('DELETE FROM corpora WHERE id=? AND revision=?')
        .run(id, expectedRevision);
      if (deleted.changes !== 1) return 'revision-conflict';
      appendEvent(this.sqlite, 'corpus.deleted', 'corpus', id, {});
      return true;
    })();
  }

  async listRecipes(corpusId: string): Promise<CorpusRecipe[]> {
    return (
      this.sqlite
        .prepare('SELECT * FROM corpus_recipes WHERE corpus_id=? ORDER BY created_at DESC,id DESC')
        .all(corpusId) as SqlRow[]
    ).map(recipeRow);
  }

  async getRecipe(id: string): Promise<CorpusRecipe | null> {
    const row = this.sqlite.prepare('SELECT * FROM corpus_recipes WHERE id=?').get(id) as
      SqlRow | undefined;
    return row ? recipeRow(row) : null;
  }

  async createRecipe(corpusId: string, input: CreateCorpusRecipeInput): Promise<CorpusRecipe> {
    return this.sqlite.transaction(() => {
      const corpus = this.sqlite
        .prepare('SELECT dataset_id FROM corpora WHERE id=?')
        .get(corpusId) as SqlRow | undefined;
      if (!corpus) throw new Error(`Corpus not found: ${corpusId}`);
      const id = randomUUID();
      const timestamp = new Date().toISOString();
      this.sqlite
        .prepare(
          `INSERT INTO corpus_recipes(
             id,corpus_id,name,dataset_id,snapshot_policy,selected_text_fields,metadata_fields,
             strip_html,unicode_normalization,deduplication,near_duplicate_threshold,chunk_size,
             chunk_overlap,language_policy,output_formats,revision,created_at,updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
        )
        .run(
          id,
          corpusId,
          input.name,
          String(corpus.dataset_id),
          JSON.stringify(input.snapshotPolicy),
          JSON.stringify(input.selectedTextFields),
          JSON.stringify(input.metadataFields),
          input.stripHtml ? 1 : 0,
          input.unicodeNormalization,
          input.deduplication,
          input.nearDuplicateThreshold,
          input.chunkSize,
          input.chunkOverlap,
          input.languagePolicy,
          JSON.stringify(input.outputFormats),
          timestamp,
          timestamp,
        );
      appendEvent(this.sqlite, 'corpus.recipe.created', 'corpus-recipe', id, { corpusId });
      return recipeRow(
        this.sqlite.prepare('SELECT * FROM corpus_recipes WHERE id=?').get(id) as SqlRow,
      );
    })();
  }

  async updateRecipe(
    corpusId: string,
    id: string,
    expectedRevision: number,
    input: CreateCorpusRecipeInput,
  ): Promise<CorpusRecipe | 'revision-conflict' | null> {
    return this.sqlite.transaction(() => {
      const current = this.sqlite
        .prepare('SELECT revision FROM corpus_recipes WHERE id=? AND corpus_id=?')
        .get(id, corpusId) as SqlRow | undefined;
      if (!current) return null;
      if (Number(current.revision) !== expectedRevision) return 'revision-conflict';
      const updated = this.sqlite
        .prepare(
          `UPDATE corpus_recipes SET name=?,snapshot_policy=?,selected_text_fields=?,metadata_fields=?,
             strip_html=?,unicode_normalization=?,deduplication=?,near_duplicate_threshold=?,
             chunk_size=?,chunk_overlap=?,language_policy=?,output_formats=?,revision=revision+1,
             updated_at=? WHERE id=? AND corpus_id=? AND revision=?`,
        )
        .run(
          input.name,
          JSON.stringify(input.snapshotPolicy),
          JSON.stringify(input.selectedTextFields),
          JSON.stringify(input.metadataFields),
          input.stripHtml ? 1 : 0,
          input.unicodeNormalization,
          input.deduplication,
          input.nearDuplicateThreshold,
          input.chunkSize,
          input.chunkOverlap,
          input.languagePolicy,
          JSON.stringify(input.outputFormats),
          new Date().toISOString(),
          id,
          corpusId,
          expectedRevision,
        );
      if (updated.changes !== 1) return 'revision-conflict';
      const recipe = recipeRow(
        this.sqlite.prepare('SELECT * FROM corpus_recipes WHERE id=?').get(id) as SqlRow,
      );
      appendEvent(this.sqlite, 'corpus.recipe.updated', 'corpus-recipe', id, {
        corpusId,
        revision: recipe.revision,
      });
      return recipe;
    })();
  }

  async deleteRecipe(
    corpusId: string,
    id: string,
    expectedRevision: number,
  ): Promise<boolean | 'revision-conflict'> {
    return this.sqlite.transaction(() => {
      const current = this.sqlite
        .prepare('SELECT revision FROM corpus_recipes WHERE id=? AND corpus_id=?')
        .get(id, corpusId) as SqlRow | undefined;
      if (!current) return false;
      if (Number(current.revision) !== expectedRevision) return 'revision-conflict';
      const deleted = this.sqlite
        .prepare('DELETE FROM corpus_recipes WHERE id=? AND corpus_id=? AND revision=?')
        .run(id, corpusId, expectedRevision);
      if (deleted.changes !== 1) return 'revision-conflict';
      appendEvent(this.sqlite, 'corpus.recipe.deleted', 'corpus-recipe', id, { corpusId });
      return true;
    })();
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
    return this.sqlite.transaction(() => {
      const timestamp = new Date().toISOString();
      this.sqlite
        .prepare(
          `INSERT INTO corpus_builds(
             id,corpus_id,recipe_id,recipe_revision,dataset_id,snapshot_id,version_id,created_at,
             started_at,completed_at
           ) VALUES (?,?,?,?,?,?,NULL,?,NULL,NULL)`,
        )
        .run(
          id,
          input.corpusId,
          input.recipeId,
          input.recipeRevision,
          input.datasetId,
          input.snapshotId,
          timestamp,
        );
      appendEvent(this.sqlite, 'corpus.build.created', 'corpus-build', id, input);
      return buildRow(
        this.sqlite.prepare('SELECT * FROM corpus_builds WHERE id=?').get(id) as SqlRow,
      );
    })();
  }

  async getBuildMetadata(id: string): Promise<CorpusBuildMetadata | null> {
    const row = this.sqlite.prepare('SELECT * FROM corpus_builds WHERE id=?').get(id) as
      SqlRow | undefined;
    return row ? buildRow(row) : null;
  }

  async listBuildMetadata(corpusId?: string, limit = 100): Promise<CorpusBuildMetadata[]> {
    const pageSize = Math.min(Math.max(limit, 1), 1000);
    const rows = corpusId
      ? (this.sqlite
          .prepare(
            'SELECT * FROM corpus_builds WHERE corpus_id=? ORDER BY created_at DESC,id DESC LIMIT ?',
          )
          .all(corpusId, pageSize) as SqlRow[])
      : (this.sqlite
          .prepare('SELECT * FROM corpus_builds ORDER BY created_at DESC,id DESC LIMIT ?')
          .all(pageSize) as SqlRow[]);
    return rows.map(buildRow);
  }

  async markBuildStarted(id: string): Promise<void> {
    this.sqlite.transaction(() => {
      const result = this.sqlite
        .prepare('UPDATE corpus_builds SET started_at=COALESCE(started_at,?) WHERE id=?')
        .run(new Date().toISOString(), id);
      if (result.changes !== 1) throw new Error(`Corpus Build not found: ${id}`);
      appendEvent(this.sqlite, 'corpus.build.started', 'corpus-build', id, {});
    })();
  }

  async markBuildFailed(id: string, code: string): Promise<void> {
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare('UPDATE corpus_builds SET completed_at=? WHERE id=?')
        .run(new Date().toISOString(), id);
      appendEvent(this.sqlite, 'corpus.build.failed', 'corpus-build', id, { code });
    })();
  }

  async markBuildCanceled(id: string): Promise<void> {
    this.sqlite.transaction(() => {
      this.sqlite
        .prepare('UPDATE corpus_builds SET completed_at=? WHERE id=?')
        .run(new Date().toISOString(), id);
      appendEvent(this.sqlite, 'corpus.build.canceled', 'corpus-build', id, {});
    })();
  }

  async saveVersion(input: Omit<CorpusVersion, 'id' | 'createdAt'>): Promise<CorpusVersion> {
    return this.sqlite.transaction(() => {
      const existingBuild = this.sqlite
        .prepare('SELECT version_id FROM corpus_builds WHERE id=?')
        .get(input.buildId) as SqlRow | undefined;
      if (existingBuild?.version_id)
        return versionRow(this.sqlite, String(existingBuild.version_id));
      const existingVersion = this.sqlite
        .prepare('SELECT id FROM corpus_versions WHERE corpus_id=? AND fingerprint=?')
        .get(input.corpusId, input.fingerprint) as SqlRow | undefined;
      if (existingVersion) {
        this.sqlite
          .prepare('UPDATE corpus_builds SET version_id=?,completed_at=? WHERE id=?')
          .run(String(existingVersion.id), new Date().toISOString(), input.buildId);
        return versionRow(this.sqlite, String(existingVersion.id));
      }
      const id = randomUUID();
      const timestamp = new Date().toISOString();
      this.sqlite
        .prepare(
          `INSERT INTO corpus_versions(
             id,corpus_id,build_id,dataset_id,snapshot_id,snapshot_fingerprint,recipe_id,
             recipe_revision,fingerprint,worker_version,stats,created_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          input.corpusId,
          input.buildId,
          input.datasetId,
          input.snapshotId,
          input.snapshotFingerprint,
          input.recipeId,
          input.recipeRevision,
          input.fingerprint,
          input.workerVersion,
          JSON.stringify(input.stats),
          timestamp,
        );
      const insertArtifact = this.sqlite.prepare(
        `INSERT INTO corpus_artifacts(
           version_id,artifact_id,kind,content_type,filename,checksum,size
         ) VALUES (?,?,?,?,?,?,?)`,
      );
      for (const artifact of input.artifacts) {
        insertArtifact.run(
          id,
          artifact.id,
          artifact.kind,
          artifact.contentType,
          artifact.filename,
          artifact.checksum,
          artifact.size,
        );
      }
      this.sqlite
        .prepare('UPDATE corpus_builds SET version_id=?,completed_at=? WHERE id=?')
        .run(id, timestamp, input.buildId);
      appendEvent(this.sqlite, 'corpus.version.created', 'corpus-version', id, {
        buildId: input.buildId,
        fingerprint: input.fingerprint,
      });
      return versionRow(this.sqlite, id);
    })();
  }

  async findVersion(corpusId: string, fingerprint: string): Promise<CorpusVersion | null> {
    const row = this.sqlite
      .prepare('SELECT id FROM corpus_versions WHERE corpus_id=? AND fingerprint=?')
      .get(corpusId, fingerprint) as SqlRow | undefined;
    return row ? versionRow(this.sqlite, String(row.id)) : null;
  }

  async getVersion(id: string): Promise<CorpusVersion | null> {
    const row = this.sqlite.prepare('SELECT id FROM corpus_versions WHERE id=?').get(id) as
      SqlRow | undefined;
    return row ? versionRow(this.sqlite, id) : null;
  }

  async listVersions(corpusId: string, limit = 100): Promise<CorpusVersion[]> {
    const rows = this.sqlite
      .prepare(
        'SELECT id FROM corpus_versions WHERE corpus_id=? ORDER BY created_at DESC,id DESC LIMIT ?',
      )
      .all(corpusId, Math.min(Math.max(limit, 1), 1000)) as SqlRow[];
    return rows.map((row) => versionRow(this.sqlite, String(row.id)));
  }
}

function corpusRow(row: SqlRow): Corpus {
  return {
    id: String(row.id),
    name: String(row.name),
    datasetId: String(row.dataset_id),
    revision: Number(row.revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function recipeRow(row: SqlRow): CorpusRecipe {
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
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function buildRow(row: SqlRow): CorpusBuildMetadata {
  return {
    id: String(row.id),
    corpusId: String(row.corpus_id),
    recipeId: String(row.recipe_id),
    recipeRevision: Number(row.recipe_revision),
    datasetId: String(row.dataset_id),
    snapshotId: String(row.snapshot_id),
    versionId: row.version_id == null ? null : String(row.version_id),
    createdAt: String(row.created_at),
    startedAt: row.started_at == null ? null : String(row.started_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
  };
}

function versionRow(sqlite: Database.Database, id: string): CorpusVersion {
  const row = sqlite.prepare('SELECT * FROM corpus_versions WHERE id=?').get(id) as SqlRow;
  const artifacts = sqlite
    .prepare('SELECT * FROM corpus_artifacts WHERE version_id=? ORDER BY artifact_id')
    .all(id) as SqlRow[];
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
    createdAt: String(row.created_at),
  };
}

function artifactRow(row: SqlRow): CorpusArtifactRef {
  return {
    id: String(row.artifact_id),
    kind: String(row.kind),
    contentType: String(row.content_type),
    filename: String(row.filename),
    checksum: String(row.checksum),
    size: Number(row.size),
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
       ) VALUES (?,?,1,'corpus',?,?,?,?)`,
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
