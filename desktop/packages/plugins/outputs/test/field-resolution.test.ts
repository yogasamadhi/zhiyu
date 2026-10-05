import { describe, expect, it } from 'vitest';
import { outputArtifactSpec } from '@zhiyun/outputs';
import type { CrawlPlanDefinition } from '@zhiyun/shared';
import type { OutputDestination } from '../src/index.js';
import { destinationReceivesRunData, resolveOutputDestinationFields } from '../src/index.js';

type LocalDirectoryDestination = Extract<OutputDestination, { type: 'local-directory' }>;

function destination(config: Record<string, unknown> = {}): LocalDirectoryDestination {
  const timestamp = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: 'Field resolution fixture',
    type: 'local-directory',
    config: {
      format: 'csv',
      pathTemplate: 'records/{runId}.csv',
      updateLatest: false,
      ...config,
    },
    credentialRef: null,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

const rule: CrawlPlanDefinition = {
  version: 1,
  list: {
    rule: {
      type: 'css',
      container: '.item',
      fields: {
        title: { selector: '.title', value: 'text', dataType: 'string' },
        url: { selector: 'a', value: 'attribute', attribute: 'href', dataType: 'url' },
      },
    },
    mode: 'auto',
    actions: [],
  },
  pagination: { type: 'none' },
  detail: {
    urlField: 'url',
    rule: {
      type: 'css',
      container: 'main',
      fields: {
        description: { selector: '.description', value: 'text', dataType: 'string' },
        title: { selector: 'h1', value: 'text', dataType: 'string' },
      },
    },
    mode: 'auto',
    actions: [],
    mergeStrategy: 'detailWins',
    onError: 'keep-list-record',
    concurrency: 2,
  },
  dedupe: { strategy: 'hash', fields: [] },
  limits: { maxRecords: 1_000_000 },
};

describe('Output field resolution', () => {
  it('keeps destination field order ahead of rule and data discovery', async () => {
    const target = destination({ fields: ['explicit', 'title'] });
    const resolved = await resolveOutputDestinationFields(
      target,
      { activeRule: { version: { definition: rule } } },
      {
        listRunRecords: async () => {
          throw new Error('configured fields must avoid scanning the run');
        },
      },
      crypto.randomUUID(),
    );
    expect(resolved).toBe(target);
  });

  it('uses active list/detail fields in authored order without duplicates', async () => {
    const resolved = await resolveOutputDestinationFields(
      destination(),
      { activeRule: { version: { definition: rule } } },
      {
        listRunRecords: async () => {
          throw new Error('active rule fields must avoid scanning the run');
        },
      },
      crypto.randomUUID(),
    );
    expect(resolved.config.fields).toEqual(['title', 'url', 'description']);
  });

  it('scans every page, sorts the union, and includes it in the artifact fingerprint', async () => {
    let reads = 0;
    const resolved = await resolveOutputDestinationFields(
      destination(),
      { activeRule: null },
      {
        listRunRecords: async (_runId, cursor) => {
          reads += 1;
          return cursor
            ? {
                items: [{ sourceUrl: 'https://example.com/2', data: { alpha: 2, late: true } }],
                nextCursor: null,
              }
            : {
                items: [{ sourceUrl: 'https://example.com/1', data: { zeta: 1 } }],
                nextCursor: 'next',
              };
        },
      },
      crypto.randomUUID(),
    );
    expect(reads).toBe(2);
    expect(resolved.config.fields).toEqual(['alpha', 'late', 'zeta']);
    const resolvedSpec = outputArtifactSpec(resolved)!;
    const differentOrder = outputArtifactSpec(destination({ fields: ['zeta', 'late', 'alpha'] }))!;
    expect(resolvedSpec.fingerprint).not.toBe(differentOrder.fingerprint);
  });
});

describe('Run data delivery subscription', () => {
  it('does not create data deliveries for event-only Webhooks', () => {
    const eventOnly = {
      ...destination(),
      type: 'webhook' as const,
      config: { url: 'https://example.com/events', events: ['run.failed', 'quality.recovered'] },
    } as OutputDestination;
    const dataWebhook = {
      ...eventOnly,
      config: { url: 'https://example.com/events', events: ['dataset.changed'] },
    } as OutputDestination;
    expect(destinationReceivesRunData(eventOnly)).toBe(false);
    expect(destinationReceivesRunData(dataWebhook)).toBe(true);
    expect(destinationReceivesRunData(destination())).toBe(true);
  });
});
