import type Database from 'better-sqlite3';
import {
  AnalysisResultQueryError,
  type AnalysisResult,
  type AnalysisResultPage,
  type AnalysisResultSection,
  type SaveAnalysisResultInput,
} from '../../contracts/index.js';

type Row = Record<string, unknown>;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export class SqliteAnalysisResultReader {
  constructor(private readonly sqlite: Database.Database) {}
  preview(id: string, limit = 20): AnalysisResult | null {
    pageLimit(limit);
    // Do not select the legacy full tables_data/series_data blobs for a first screen.
    const row = this.sqlite
      .prepare(
        `SELECT id,job_id,dataset_id,snapshot_id,method_id,method_version,
      summary,metrics,warnings,sampling,worker_version,created_at,parameters,provenance FROM analysis_results WHERE id=?`,
      )
      .get(id) as Row | undefined;
    if (!row) return null;
    const collections = this.sqlite
      .prepare(
        'SELECT * FROM analysis_result_collections WHERE result_id=? ORDER BY section,position',
      )
      .all(id) as Row[];
    const tables: AnalysisResult['tables'] = [],
      series: AnalysisResult['series'] = [];
    for (const collection of collections) {
      const section = collection.section as AnalysisResultSection;
      const page = this.page(id, section, String(collection.collection_id), limit)!;
      if (section === 'table')
        tables.push({
          id: page.collectionId,
          rows: page.items,
          totalRows: page.totalRows,
          nextCursor: page.nextCursor,
          ...(collection.columns_data === null
            ? {}
            : { columns: array(collection.columns_data) as Array<Record<string, unknown>> }),
          ...(collection.artifact_id === null
            ? {}
            : { artifactId: String(collection.artifact_id) }),
        });
      else
        series.push({
          id: page.collectionId,
          type: String(collection.series_type),
          data: page.items,
          totalRows: page.totalRows,
          nextCursor: page.nextCursor,
          ...(collection.encoding_data == null
            ? {}
            : {
                encoding: object(collection.encoding_data) as unknown as NonNullable<
                  AnalysisResult['series'][number]['encoding']
                >,
              }),
        });
    }
    const artifacts = this.sqlite
      .prepare('SELECT * FROM analysis_artifacts WHERE result_id=? ORDER BY artifact_id')
      .all(id) as Row[];
    const result: AnalysisResult = {
      id,
      state: 'succeeded',
      jobId: String(row.job_id),
      datasetId: String(row.dataset_id),
      snapshotId: String(row.snapshot_id),
      methodId: String(row.method_id),
      methodVersion: String(row.method_version),
      parameters: object(row.parameters),
      provenance:
        row.provenance == null
          ? null
          : (object(row.provenance) as unknown as NonNullable<AnalysisResult['provenance']>),
      summary: object(row.summary),
      metrics: object(row.metrics),
      tables,
      series,
      artifacts: artifacts.map((artifact) => ({
        id: String(artifact.artifact_id),
        kind: String(artifact.kind),
        contentType: String(artifact.content_type),
        filename: String(artifact.filename),
      })),
      warnings: array(row.warnings).map(String),
      sampling: object(row.sampling) as unknown as AnalysisResult['sampling'],
      workerVersion: String(row.worker_version),
      createdAt: String(row.created_at),
    };
    bound(result);
    return result;
  }
  page(
    id: string,
    section: AnalysisResultSection,
    collectionId: string,
    limit = 50,
    cursor?: string,
  ): AnalysisResultPage | null {
    pageLimit(limit);
    if (!['table', 'series'].includes(section) || !collectionId || collectionId.length > 255)
      throw new AnalysisResultQueryError('VALIDATION_ERROR', 'Invalid result collection');
    const collection = this.sqlite
      .prepare(
        'SELECT total_rows FROM analysis_result_collections WHERE result_id=? AND section=? AND collection_id=?',
      )
      .get(id, section, collectionId) as Row | undefined;
    if (!collection) return null;
    const totalRows = Number(collection.total_rows),
      index = cursor !== undefined ? decodeCursor(cursor, id, section, collectionId) : 0;
    if (index > totalRows)
      throw new AnalysisResultQueryError('INVALID_CURSOR', 'Result cursor is past the collection');
    const rows = this.sqlite
      .prepare(
        `SELECT row_index,row_data FROM analysis_result_rows WHERE result_id=? AND section=? AND collection_id=? AND row_index>=? ORDER BY row_index LIMIT ?`,
      )
      .all(id, section, collectionId, index, limit) as Row[];
    const nextIndex = rows.length ? Number(rows.at(-1)!.row_index) + 1 : index;
    const page = {
      resultId: id,
      section,
      collectionId,
      items: rows.map((row) => object(row.row_data)),
      totalRows,
      nextCursor: nextIndex < totalRows ? encodeCursor(id, section, collectionId, nextIndex) : null,
    };
    bound(page);
    return page;
  }
}

export function saveResultCollections(
  sqlite: Database.Database,
  id: string,
  input: SaveAnalysisResultInput,
) {
  const insertCollection = sqlite.prepare(
    `INSERT INTO analysis_result_collections(result_id,section,collection_id,position,series_type,encoding_data,columns_data,artifact_id,total_rows) VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const insertRow = sqlite.prepare(
    'INSERT INTO analysis_result_rows(result_id,section,collection_id,row_index,row_data) VALUES (?,?,?,?,?)',
  );
  for (const section of ['table', 'series'] as const) {
    const collections = section === 'table' ? input.tables : input.series;
    if (collections.length > 50)
      throw new AnalysisResultQueryError(
        'RESOURCE_LIMIT_EXCEEDED',
        'Too many result collections',
        413,
      );
    const names = new Set<string>();
    for (const [position, collection] of collections.entries()) {
      if (!collection.id || collection.id.length > 255 || names.has(collection.id))
        throw new AnalysisResultQueryError(
          'INVALID_WORKER_RESULT',
          'Result collection IDs must be bounded and unique',
        );
      names.add(collection.id);
      const rows = 'rows' in collection ? collection.rows : collection.data;
      if (!Array.isArray(rows) || rows.some((row) => !isObject(row)))
        throw new AnalysisResultQueryError('INVALID_WORKER_RESULT', 'Result rows must be objects');
      const columns = 'columns' in collection ? collection.columns : undefined;
      const columnNames = new Set<string>();
      if (section === 'table')
        for (const row of rows) for (const key of Object.keys(row)) columnNames.add(key);
      const inferredColumns =
        section === 'table' ? [...columnNames].sort().map((name) => ({ name })) : null;
      insertCollection.run(
        id,
        section,
        collection.id,
        position,
        'type' in collection ? collection.type : null,
        'encoding' in collection && collection.encoding != null
          ? JSON.stringify(collection.encoding)
          : null,
        JSON.stringify(columns ?? inferredColumns),
        'artifactId' in collection ? (collection.artifactId ?? null) : null,
        rows.length,
      );
      for (const [index, row] of rows.entries())
        insertRow.run(id, section, collection.id, index, JSON.stringify(row));
    }
  }
}
function encodeCursor(
  resultId: string,
  section: AnalysisResultSection,
  collectionId: string,
  index: number,
) {
  return Buffer.from(JSON.stringify({ v: 1, resultId, section, collectionId, index })).toString(
    'base64url',
  );
}
function decodeCursor(
  value: string,
  resultId: string,
  section: AnalysisResultSection,
  collectionId: string,
): number {
  try {
    if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
    const raw = Buffer.from(value, 'base64url');
    if (raw.toString('base64url') !== value) throw new Error('Invalid encoding');
    const data = JSON.parse(raw.toString('utf8')) as unknown;
    if (
      !isObject(data) ||
      Object.keys(data).sort().join(',') !== 'collectionId,index,resultId,section,v' ||
      data.v !== 1 ||
      data.resultId !== resultId ||
      data.section !== section ||
      data.collectionId !== collectionId ||
      !Number.isSafeInteger(data.index) ||
      Number(data.index) < 0
    )
      throw new Error('Invalid scope');
    return Number(data.index);
  } catch (error) {
    throw new AnalysisResultQueryError('INVALID_CURSOR', 'Invalid result cursor', 400, {
      cause: error,
    });
  }
}
function pageLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new AnalysisResultQueryError(
      'VALIDATION_ERROR',
      'Result page limit must be an integer from 1 to 200',
    );
}
function bound(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_RESPONSE_BYTES)
    throw new AnalysisResultQueryError(
      'RESOURCE_LIMIT_EXCEEDED',
      'Result page exceeds 4MiB; reduce the page size',
      413,
    );
}
function isObject(value: unknown): value is Row {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function object(value: unknown): Row {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  return isObject(parsed) ? parsed : {};
}
function array(value: unknown): unknown[] {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed : [];
}
