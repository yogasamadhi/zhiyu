import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import Database from 'better-sqlite3';

const RESET_MARKER = '.zhiyun-v1-resetting';
const RESET_MARKER_CONTENT = '{"operation":"legacy-to-1.0","version":1}\n';
const LEGACY_SIGNATURE = ['tasks', 'rules', 'runs', 'records'];

export interface PrepareSqliteV1Options {
  dataDirectory: string;
  filePath: string;
}

export interface PreparedSqliteV1 {
  markerPath: string | null;
  resetPerformed: boolean;
}

export async function prepareSqliteV1(options: PrepareSqliteV1Options): Promise<PreparedSqliteV1> {
  const dataDirectory = resolve(options.dataDirectory);
  const filePath = resolve(options.filePath);
  validateControlledDatabasePath(dataDirectory, filePath);
  await mkdir(dataDirectory, { recursive: true });
  const canonicalDataDirectory = await realpath(dataDirectory);
  await validateControlledTarget(canonicalDataDirectory, filePath);
  const markerPath = join(dataDirectory, RESET_MARKER);
  if (existsSync(markerPath)) {
    await validateControlledTarget(canonicalDataDirectory, markerPath);
    if ((await readFile(markerPath, 'utf8')) !== RESET_MARKER_CONTENT) {
      throw new Error('Invalid SQLite reset marker; refusing destructive reset');
    }
    if (existsSync(filePath)) {
      const tables = readTables(filePath);
      if (tables.includes('zhiyun_meta')) {
        await unlink(markerPath);
        return { markerPath: null, resetPerformed: false };
      }
      if (tables.length > 0 && !isLegacySchema(tables)) {
        throw new Error(
          `Unknown SQLite schema during reset recovery; refusing destructive reset: ${tables.sort().join(', ')}`,
        );
      }
    }
    await resetControlledData(canonicalDataDirectory, filePath, markerPath);
    return { markerPath, resetPerformed: true };
  }
  if (!existsSync(filePath)) return { markerPath: null, resetPerformed: false };

  const tables = readTables(filePath);
  if (tables.length === 0 || tables.includes('zhiyun_meta')) {
    return { markerPath: null, resetPerformed: false };
  }
  if (!isLegacySchema(tables)) {
    throw new Error(
      `Unknown SQLite schema; refusing destructive reset: ${tables.sort().join(', ')}`,
    );
  }
  await writeFile(markerPath, RESET_MARKER_CONTENT, { flag: 'wx' });
  await resetControlledData(canonicalDataDirectory, filePath, markerPath);
  return { markerPath, resetPerformed: true };
}

export async function completeSqliteV1Reset(markerPath: string | null): Promise<void> {
  if (markerPath) await unlink(markerPath).catch(() => undefined);
}

async function resetControlledData(
  canonicalDataDirectory: string,
  filePath: string,
  markerPath: string,
): Promise<void> {
  const targets = [
    filePath,
    `${filePath}-wal`,
    `${filePath}-shm`,
    join(dirname(filePath), 'artifacts'),
    join(dirname(filePath), 'credentials'),
    join(dirname(filePath), 'job-workspaces'),
  ];
  for (const target of targets) {
    await validateControlledTarget(canonicalDataDirectory, target);
  }
  for (const target of targets) {
    await rm(target, { recursive: true, force: true });
  }
  if (!existsSync(markerPath)) {
    await writeFile(markerPath, RESET_MARKER_CONTENT, { flag: 'wx' });
  }
}

function readTables(filePath: string): string[] {
  const database = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    return (
      database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
    ).map(({ name }) => name);
  } finally {
    database.close();
  }
}

function isLegacySchema(tables: string[]): boolean {
  return LEGACY_SIGNATURE.every((table) => tables.includes(table));
}

function validateControlledDatabasePath(dataDirectory: string, filePath: string): void {
  if (!isAbsolute(dataDirectory) || !isAbsolute(filePath)) {
    throw new Error('SQLite reset paths must be absolute');
  }
  if (basename(filePath) !== 'zhiyun.sqlite3' || dirname(filePath) !== dataDirectory) {
    throw new Error('SQLite v1 database must be the direct userData/zhiyun.sqlite3 file');
  }
}

async function validateControlledTarget(
  canonicalDataDirectory: string,
  target: string,
): Promise<void> {
  const lexicalPath = resolve(target);
  const lexicalChild = relative(resolve(dirname(target)), lexicalPath);
  if (!lexicalChild || lexicalChild.startsWith('..') || isAbsolute(lexicalChild)) {
    throw new Error(`Refusing unresolved reset target ${lexicalPath}`);
  }
  const path = existsSync(lexicalPath)
    ? await realpath(lexicalPath)
    : join(canonicalDataDirectory, basename(lexicalPath));
  const child = relative(canonicalDataDirectory, path);
  if (!child || child.startsWith('..') || isAbsolute(child)) {
    throw new Error(`Refusing uncontrolled reset target ${path}`);
  }
}
