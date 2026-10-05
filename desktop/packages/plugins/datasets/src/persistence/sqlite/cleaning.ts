import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { cleaningParametersSchema } from '@zhiyun/shared';
import type {
  DatasetCleaningRecipe,
  DatasetCleaningRecipeVersion,
  DatasetCleaningRepository,
  DatasetCleaningSession,
  PublishCleaningSessionInput,
  SaveCleaningRecipeInput,
} from '../../contracts/cleaning.js';
import { snapshotRow } from './snapshot-row.js';
import { DatasetCleaningConflictError } from '../../contracts/cleaning.js';
export { DatasetCleaningConflictError } from '../../contracts/cleaning.js';

type Row = Record<string, unknown>;
const id = z.uuid();
const revision = z.number().int().positive();
const recipeInput = z
  .object({
    datasetId: id,
    name: z.string().trim().min(1).max(120),
    steps: cleaningParametersSchema.shape.steps.min(1),
    expectedFields: cleaningParametersSchema.shape.expectedFields,
    recipeId: id.optional(),
    expectedRevision: revision.optional(),
  })
  .strict()
  .refine(
    (input) => (input.recipeId === undefined) === (input.expectedRevision === undefined),
    'Recipe updates require the expected revision',
  );
const publishInput = z
  .object({
    datasetId: id,
    inputSnapshotId: id,
    recipeVersionId: id,
    reportArtifactId: id,
    steps: z
      .array(
        z
          .object({
            fingerprint: z
              .string()
              .length(64)
              .regex(/^[a-f0-9]{64}$/),
            rowCount: z.number().int().min(0).max(1_000_000),
            parquetArtifactId: id,
            manifestArtifactId: id,
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

/** Owns cleaning history; selection changes never write to source records or artifact files. */
export class SqliteDatasetCleaningRepository implements DatasetCleaningRepository {
  private readonly sqlite: Database.Database;
  private readonly ownsConnection: boolean;

  constructor(source: string | Database.Database) {
    this.ownsConnection = typeof source === 'string';
    this.sqlite =
      typeof source === 'string' ? new Database(source, { fileMustExist: true }) : source;
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
  }

  async close(): Promise<void> {
    if (this.ownsConnection && this.sqlite.open) this.sqlite.close();
  }

  async saveRecipe(value: SaveCleaningRecipeInput) {
    const input = recipeInput.parse(value);
    return this.sqlite.transaction(() => {
      if (!this.sqlite.prepare('SELECT id FROM datasets WHERE id=?').get(input.datasetId))
        throw new Error('Dataset was not found');
      const previous = input.recipeId
        ? (this.sqlite
            .prepare('SELECT * FROM dataset_cleaning_recipes WHERE id=?')
            .get(input.recipeId) as Row | undefined)
        : undefined;
      if (
        input.recipeId &&
        (!previous ||
          previous.dataset_id !== input.datasetId ||
          previous.revision !== input.expectedRevision)
      )
        throw new DatasetCleaningConflictError('Cleaning recipe changed; reload before saving');
      const recipeId = input.recipeId ?? randomUUID();
      const nextRevision = previous ? Number(previous.revision) + 1 : 1;
      const versionId = randomUUID();
      const timestamp = new Date().toISOString();
      if (previous) {
        this.sqlite
          .prepare(
            'UPDATE dataset_cleaning_recipes SET name=?,revision=?,current_version_id=?,updated_at=? WHERE id=?',
          )
          .run(input.name, nextRevision, versionId, timestamp, recipeId);
      } else {
        this.sqlite
          .prepare(
            'INSERT INTO dataset_cleaning_recipes(id,dataset_id,name,revision,current_version_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
          )
          .run(
            recipeId,
            input.datasetId,
            input.name,
            nextRevision,
            versionId,
            timestamp,
            timestamp,
          );
      }
      this.sqlite
        .prepare(
          'INSERT INTO dataset_cleaning_recipe_versions(id,recipe_id,revision,name,steps,expected_fields,created_at) VALUES (?,?,?,?,?,?,?)',
        )
        .run(
          versionId,
          recipeId,
          nextRevision,
          input.name,
          JSON.stringify(input.steps),
          JSON.stringify(input.expectedFields),
          timestamp,
        );
      return {
        recipe: recipeRow(
          this.sqlite
            .prepare('SELECT * FROM dataset_cleaning_recipes WHERE id=?')
            .get(recipeId) as Row,
        ),
        version: versionRow(
          this.sqlite
            .prepare('SELECT * FROM dataset_cleaning_recipe_versions WHERE id=?')
            .get(versionId) as Row,
        ),
      };
    })();
  }

  async getRecipe(value: string): Promise<DatasetCleaningRecipe | null> {
    const row = this.sqlite
      .prepare('SELECT * FROM dataset_cleaning_recipes WHERE id=?')
      .get(id.parse(value)) as Row | undefined;
    return row ? recipeRow(row) : null;
  }

  async getRecipeVersion(value: string): Promise<DatasetCleaningRecipeVersion | null> {
    const row = this.sqlite
      .prepare('SELECT * FROM dataset_cleaning_recipe_versions WHERE id=?')
      .get(id.parse(value)) as Row | undefined;
    return row ? versionRow(row) : null;
  }

  async listRecipes(datasetId: string): Promise<DatasetCleaningRecipe[]> {
    return (
      this.sqlite
        .prepare(
          'SELECT * FROM dataset_cleaning_recipes WHERE dataset_id=? ORDER BY updated_at DESC,id DESC',
        )
        .all(id.parse(datasetId)) as Row[]
    ).map(recipeRow);
  }

  async publishSession(value: PublishCleaningSessionInput) {
    const input = publishInput.parse(value);
    return this.sqlite.transaction(() => {
      const source = this.sqlite
        .prepare("SELECT * FROM dataset_snapshots WHERE id=? AND dataset_id=? AND status='ready'")
        .get(input.inputSnapshotId, input.datasetId) as Row | undefined;
      if (!source || !source.parquet_artifact_id || !source.manifest_artifact_id)
        throw new Error('Cleaning requires a ready input Snapshot');
      const version = this.sqlite
        .prepare('SELECT * FROM dataset_cleaning_recipe_versions WHERE id=?')
        .get(input.recipeVersionId) as Row | undefined;
      if (!version || versionRow(version).steps.length !== input.steps.length)
        throw new Error('Cleaning results do not match the recipe version');
      const operations = versionRow(version).steps;
      let parentRowCount = Number(source.row_count);
      input.steps.forEach((step, index) => {
        if (
          operations[index]!.type === 'dedupe'
            ? step.rowCount > parentRowCount
            : step.rowCount !== parentRowCount
        )
          throw new Error('Cleaning row counts do not match the operation');
        parentRowCount = step.rowCount;
      });
      if (
        new Set(input.steps.map((step) => step.fingerprint)).size !== input.steps.length ||
        input.steps.some((step) => step.fingerprint === source.fingerprint)
      )
        throw new Error('Cleaning results must have distinct derived fingerprints');
      const timestamp = new Date().toISOString();
      const snapshotIds = input.steps.map(() => randomUUID());
      let sequence = Number(
        (
          this.sqlite
            .prepare(
              'SELECT COALESCE(MAX(sequence),0) AS n FROM dataset_snapshots WHERE dataset_id=?',
            )
            .get(input.datasetId) as Row
        ).n,
      );
      const snapshots = input.steps.map((step, index) => {
        const snapshotId = snapshotIds[index]!;
        this.sqlite
          .prepare(
            `INSERT INTO dataset_snapshots(id,dataset_id,source_run_id,fingerprint,schema_version,projection_settings,status,stats,row_count,parquet_artifact_id,manifest_artifact_id,warnings,created_at,updated_at,sequence) VALUES (?,?,NULL,?,?,?,'ready',?,?,?,?,'[]',?,?,?)`,
          )
          .run(
            snapshotId,
            input.datasetId,
            step.fingerprint,
            source.schema_version,
            JSON.stringify({
              kind: 'cleaning',
              inputSnapshotId: index === 0 ? input.inputSnapshotId : snapshotIds[index - 1]!,
              rootSnapshotId: input.inputSnapshotId,
              recipeVersionId: input.recipeVersionId,
              step: index + 1,
            }),
            JSON.stringify({
              added: 0,
              updated: 0,
              removed: 0,
              unchanged: 0,
              current: step.rowCount,
            }),
            step.rowCount,
            step.parquetArtifactId,
            step.manifestArtifactId,
            timestamp,
            timestamp,
            ++sequence,
          );
        return snapshotRow(
          this.sqlite.prepare('SELECT * FROM dataset_snapshots WHERE id=?').get(snapshotId) as Row,
        );
      });
      const sessionId = randomUUID();
      this.sqlite
        .prepare(
          'INSERT INTO dataset_cleaning_sessions(id,dataset_id,input_snapshot_id,recipe_version_id,output_snapshot_ids,selected_step,revision,report_artifact_id,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?,?)',
        )
        .run(
          sessionId,
          input.datasetId,
          input.inputSnapshotId,
          input.recipeVersionId,
          JSON.stringify(snapshots.map((item) => item.id)),
          snapshots.length,
          input.reportArtifactId,
          timestamp,
          timestamp,
        );
      return {
        session: sessionRow(
          this.sqlite
            .prepare('SELECT * FROM dataset_cleaning_sessions WHERE id=?')
            .get(sessionId) as Row,
        ),
        snapshots,
      };
    })();
  }

  async getSession(value: string): Promise<DatasetCleaningSession | null> {
    const row = this.sqlite
      .prepare('SELECT * FROM dataset_cleaning_sessions WHERE id=?')
      .get(id.parse(value)) as Row | undefined;
    return row ? sessionRow(row) : null;
  }

  async listSessions(datasetId: string): Promise<DatasetCleaningSession[]> {
    return (
      this.sqlite
        .prepare(
          'SELECT * FROM dataset_cleaning_sessions WHERE dataset_id=? ORDER BY created_at DESC,id DESC',
        )
        .all(id.parse(datasetId)) as Row[]
    ).map(sessionRow);
  }

  async selectStep(sessionId: string, selectedStep: number, expectedRevision: number) {
    id.parse(sessionId);
    z.number().int().min(0).max(20).parse(selectedStep);
    revision.parse(expectedRevision);
    return this.sqlite.transaction(() => {
      const row = this.sqlite
        .prepare('SELECT * FROM dataset_cleaning_sessions WHERE id=?')
        .get(sessionId) as Row | undefined;
      if (!row || row.revision !== expectedRevision)
        throw new DatasetCleaningConflictError(
          'Cleaning history changed; reload before selecting a step',
        );
      const current = sessionRow(row);
      if (selectedStep > current.outputSnapshotIds.length)
        throw new Error('Cleaning step was not found');
      const snapshotId =
        selectedStep === 0 ? current.inputSnapshotId : current.outputSnapshotIds[selectedStep - 1]!;
      if (
        !this.sqlite
          .prepare(
            "SELECT id FROM dataset_snapshots WHERE id=? AND dataset_id=? AND status='ready'",
          )
          .get(snapshotId, current.datasetId)
      )
        throw new Error('Selected Snapshot is unavailable');
      this.sqlite
        .prepare(
          'UPDATE dataset_cleaning_sessions SET selected_step=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?',
        )
        .run(selectedStep, new Date().toISOString(), sessionId, expectedRevision);
      return sessionRow(
        this.sqlite
          .prepare('SELECT * FROM dataset_cleaning_sessions WHERE id=?')
          .get(sessionId) as Row,
      );
    })();
  }
}

function recipeRow(row: Row): DatasetCleaningRecipe {
  return {
    id: String(row.id),
    datasetId: String(row.dataset_id),
    name: String(row.name),
    revision: Number(row.revision),
    currentVersionId: String(row.current_version_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function versionRow(row: Row): DatasetCleaningRecipeVersion {
  const parsed = cleaningParametersSchema.parse({
    fingerprint: '0'.repeat(64),
    manifestArtifactRef: 'manifest.json',
    steps: JSON.parse(String(row.steps)),
    expectedFields: JSON.parse(String(row.expected_fields)),
  });
  return {
    id: String(row.id),
    recipeId: String(row.recipe_id),
    revision: Number(row.revision),
    name: String(row.name),
    steps: parsed.steps,
    expectedFields: parsed.expectedFields,
    createdAt: String(row.created_at),
  };
}

function sessionRow(row: Row): DatasetCleaningSession {
  const outputSnapshotIds = z
    .array(id)
    .min(1)
    .max(20)
    .parse(JSON.parse(String(row.output_snapshot_ids)));
  const selectedStep = Number(row.selected_step);
  if (
    !Number.isInteger(selectedStep) ||
    selectedStep < 0 ||
    selectedStep > outputSnapshotIds.length
  )
    throw new Error('Invalid persisted cleaning history');
  return {
    id: String(row.id),
    datasetId: String(row.dataset_id),
    inputSnapshotId: String(row.input_snapshot_id),
    recipeVersionId: String(row.recipe_version_id),
    outputSnapshotIds,
    selectedStep,
    selectedSnapshotId:
      selectedStep === 0 ? String(row.input_snapshot_id) : outputSnapshotIds[selectedStep - 1]!,
    revision: Number(row.revision),
    reportArtifactId: String(row.report_artifact_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
