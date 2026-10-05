import { createHash } from 'node:crypto';
import type { DatasetRepository } from '../contracts/index.js';
import { recordQueryCursor, recordQueryOffset } from '../domain/query.js';

// Replaying durable changes includes accumulated upserts and removals, unlike comparing
// raw rows of two crawls. Snapshot order is an incrementing per-dataset sequence.
export async function compareDatasetRuns(
  repository: DatasetRepository,
  datasetId: string,
  from: string | undefined,
  to: string,
  cursor?: string,
  limit = 100,
) {
  const snapshots = (await repository.listSnapshots(datasetId))
    .filter((s) => s.sourceRunId)
    .reverse();
  if (
    !snapshots.some((s) => s.sourceRunId === to) ||
    (from && !snapshots.some((s) => s.sourceRunId === from))
  )
    throw new Error('VALIDATION_ERROR: Both runs must belong to this dataset');
  let before = new Map<string, Record<string, unknown>>();
  let after = new Map<string, Record<string, unknown>>();
  const state = new Map<string, Record<string, unknown>>();
  for (const snapshot of snapshots) {
    let next: string | undefined;
    do {
      const page = await repository.listChanges(datasetId, next, 500, snapshot.sourceRunId!);
      for (const change of page.items) {
        if (change.type === 'removed') state.delete(change.datasetRecordId);
        else if (change.after) state.set(change.datasetRecordId, change.after);
      }
      next = page.nextCursor ?? undefined;
    } while (next);
    if (snapshot.sourceRunId === from) before = new Map(state);
    if (snapshot.sourceRunId === to) after = new Map(state);
  }
  const items: Array<{
    recordKey: string;
    type: 'added' | 'updated' | 'removed';
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  }> = [];
  const stats = { added: 0, updated: 0, removed: 0 };
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const a = before.get(key) ?? null,
      b = after.get(key) ?? null;
    if (canonical(a) === canonical(b)) continue;
    const type = !a ? 'added' : !b ? 'removed' : 'updated';
    stats[type]++;
    items.push({ recordKey: key, type, before: a, after: b });
  }
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([datasetId, from, to, items]))
    .digest('hex');
  const offset = recordQueryOffset(cursor, fingerprint);
  const size = Math.min(limit, 500);
  return {
    items: items.slice(offset, offset + size),
    stats,
    nextCursor: items.length > offset + size ? recordQueryCursor(offset + size, fingerprint) : null,
  };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
