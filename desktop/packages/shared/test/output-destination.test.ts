import { describe, expect, it } from 'vitest';
import {
  assertNoSensitiveOutputConfig,
  outputDestinationSchema,
  sensitiveOutputConfigPaths,
  stripOutputDestinationConfig,
  taskOriginSchema,
  webhookEventTypeSchema,
} from '../src/index.js';

function destination(type: string, config: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: 'Output fixture',
    type,
    config,
    credentialRef: null,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe('Output Destination config security', () => {
  it('accepts recruitment events and managed recruitment task origins', () => {
    for (const event of [
      'recruitment.match.detected',
      'recruitment.posting.changed',
      'recruitment.digest.ready',
    ]) {
      expect(webhookEventTypeSchema.parse(event)).toBe(event);
    }
    expect(
      taskOriginSchema.parse({
        kind: 'managed',
        ownerPluginId: 'recruitment',
        sourceKey: 'boss',
        searchProfileId: crypto.randomUUID(),
      }),
    ).toMatchObject({ kind: 'managed', ownerPluginId: 'recruitment' });
  });

  it('uses per-type allowlists and strips harmless unknown properties', () => {
    const fixtures = [
      destination('webhook', {
        url: 'https://example.com/hook',
        events: ['run.succeeded'],
        harmlessUnknown: true,
      }),
      destination('postgres', {
        schema: 'public',
        table: 'records',
        harmlessUnknown: true,
      }),
      destination('local-directory', {
        pathTemplate: '{taskSlug}/{runId}.{ext}',
        taskSlug: 'fixture',
        fields: ['id'],
        harmlessUnknown: true,
      }),
      destination('google-sheets', {
        spreadsheetId: 'spreadsheet_123456789',
        clientEmail: 'service@example.com',
        harmlessUnknown: true,
      }),
      destination('s3', {
        bucket: 'fixture-bucket',
        taskSlug: 'fixture',
        fields: ['id'],
        harmlessUnknown: true,
      }),
    ];

    for (const fixture of fixtures) {
      const parsed = outputDestinationSchema.parse(fixture);
      expect(parsed.config).not.toHaveProperty('harmlessUnknown');
    }
  });

  it('defaults Google Sheets to automatic dataset-aware mode', () => {
    expect(
      outputDestinationSchema.parse(
        destination('google-sheets', { spreadsheetId: 'spreadsheet_123456789' }),
      ).config,
    ).toMatchObject({ sheetName: 'Records', mode: 'auto', columns: [] });
  });

  it('rejects sensitive keys and private-key material at any nesting depth', () => {
    const config = {
      bucket: 'fixture-bucket',
      nested: {
        values: [{ harmless: true }, { secret_access_key: 'must-not-persist' }],
      },
      opaque: '-----BEGIN PRIVATE KEY-----\nmaterial\n-----END PRIVATE KEY-----',
    };
    expect(sensitiveOutputConfigPaths(config)).toEqual([
      'config.nested.values[1].secret_access_key',
      'config.opaque',
    ]);
    expect(() => assertNoSensitiveOutputConfig(config)).toThrow(
      'config.nested.values[1].secret_access_key',
    );
    expect(outputDestinationSchema.safeParse(destination('s3', config)).success).toBe(false);
  });

  it('can strip an unsafe legacy row without returning the secret', () => {
    const stripped = stripOutputDestinationConfig('s3', {
      bucket: 'fixture-bucket',
      secretAccessKey: 'legacy-secret',
      nested: { privateKey: 'legacy-private-key' },
    });
    expect(stripped).toMatchObject({ bucket: 'fixture-bucket', region: 'us-east-1' });
    expect(JSON.stringify(stripped)).not.toContain('legacy-secret');
    expect(JSON.stringify(stripped)).not.toContain('legacy-private-key');
  });

  it('requires immutable archive templates to include the run id', () => {
    expect(
      outputDestinationSchema.safeParse(
        destination('local-directory', { pathTemplate: '{taskSlug}/latest.csv' }),
      ).success,
    ).toBe(false);
    expect(
      outputDestinationSchema.safeParse(
        destination('s3', { bucket: 'fixture-bucket', pathTemplate: 'latest.jsonl' }),
      ).success,
    ).toBe(false);
  });
});
