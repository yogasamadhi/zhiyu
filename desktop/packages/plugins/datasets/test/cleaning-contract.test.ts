import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cleaningParametersSchema,
  cleaningResultSchema,
  type CleaningParameters,
} from '@zhiyun/shared';
import type { WorkerCleaningParameters } from '@zhiyun/analytics-worker-client';
import { testEnvironment } from '../../../../../tooling/scripts/test-environment.js';

const desktop = resolve(import.meta.dirname, '../../../..');
const fixture = JSON.parse(
  await readFile(resolve(desktop, 'tooling/evaluations/cleaning-fixtures.json'), 'utf8'),
) as {
  version: string;
  cases: Array<{
    id: string;
    rows: unknown[];
    steps: unknown[];
    expected: unknown[];
    errorRows: number;
    removedRows: number;
  }>;
  invalidSteps: unknown[];
};
const parameters = (steps: unknown[]) => ({
  fingerprint: 'a'.repeat(64),
  manifestArtifactRef: 'schema-manifest.json',
  steps,
});

// Compilation also proves normalized shared parameters fit the generated Worker contract.
const generatedParameters = (input: CleaningParameters): WorkerCleaningParameters => input;

describe('cleaning TS/Python contract', () => {
  it('matches strict defaults and rejects arbitrary execution and invalid references', async () => {
    const base = parameters([]);
    const vectors: unknown[] = [
      base,
      ...fixture.cases.map((item) => parameters(item.steps)),
      ...fixture.invalidSteps.map((step) => parameters([step])),
      ...[
        '/tmp/manifest.json',
        '../manifest.json',
        'a/../manifest.json',
        'a//manifest.json',
        './manifest.json',
        'C:\\manifest.json',
        'a\\manifest.json',
        '',
      ].map((manifestArtifactRef) => ({ ...base, manifestArtifactRef })),
      { ...base, previewLimit: true },
      { ...base, facetLimit: 0 },
      { ...base, steps: Array.from({ length: 21 }, () => ({ type: 'trim', fields: ['value'] })) },
      { ...base, extra: 'reject' },
      { ...base, expectedFields: { value: 'json' } },
      { ...base, fingerprint: 'a'.repeat(64) + '\n' },
      parameters([{ type: 'trim', fields: ['🧪'.repeat(255)] }]),
      parameters([{ type: 'normalize_null', fields: ['value'], tokens: ['🧪'.repeat(1000)] }]),
      parameters([{ type: 'trim', fields: ['🧪'.repeat(256)] }]),
      parameters([{ type: 'normalize_null', fields: ['value'], tokens: ['🧪'.repeat(1001)] }]),
    ];
    const stdout = await new Promise<string>((resolveOutput, reject) => {
      const child = execFile(
        'uv',
        ['run', 'python', 'tests/export_cleaning_fixtures.py'],
        {
          cwd: resolve(desktop, 'analytics-worker'),
          env: testEnvironment(process.env),
          timeout: 30_000,
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, output) => (error ? reject(error) : resolveOutput(output)),
      );
      child.stdin!.end(JSON.stringify(vectors));
    });
    const actual = JSON.parse(stdout) as {
      version: string;
      cases: Array<{
        id: string;
        parameters: unknown;
        result: unknown;
        records: unknown[];
        sourceUnchanged: boolean;
      }>;
      vectors: Array<{ accepted: boolean; parameters?: unknown }>;
    };
    expect(actual.version).toBe(fixture.version);
    expect(actual.vectors).toHaveLength(vectors.length);
    vectors.forEach((vector, index) => {
      const parsed = cleaningParametersSchema.safeParse(vector);
      expect(parsed.success, `expected acceptance for vector ${index}`).toBe(
        index < 8 || index === 31 || index === 32,
      );
      expect(actual.vectors[index]!.accepted, `vector ${index}`).toBe(parsed.success);
      if (parsed.success)
        expect(actual.vectors[index]!.parameters).toEqual(generatedParameters(parsed.data));
    });
    for (const expected of fixture.cases) {
      const output = actual.cases.find((item) => item.id === expected.id)!;
      expect(output.sourceUnchanged, expected.id).toBe(true);
      expect(output.parameters).toEqual(cleaningParametersSchema.parse(parameters(expected.steps)));
      const result = cleaningResultSchema.parse(output.result);
      expect(output.records, expected.id).toEqual(expected.expected);
      expect(result.rowCount).toBe(expected.expected.length);
      expect(result.steps[0]!.errorRowCount).toBe(expected.errorRows);
      expect(result.steps[0]!.removedRowCount).toBe(expected.removedRows);
    }
  });
});
