import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  GoogleSheetsOutputAdapter,
  googleServiceAccountClientEmail,
  type OutputDestinationLike,
} from '../src/index.js';

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ format: 'pem', type: 'pkcs8' })
  .toString();

const credential = {
  serviceAccountJson: JSON.stringify({
    client_email: 'zhiyun@example-project.iam.gserviceaccount.com',
    private_key: privateKey,
  }),
};

function destination(config: Record<string, unknown>): OutputDestinationLike {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: 'Google Sheets fixture',
    type: 'google-sheets',
    config: { spreadsheetId: 'spreadsheet_123456789', sheetName: 'Data', ...config },
    credentialRef: 'credential:test',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Google Sheets output', () => {
  it('tests both read and write permissions using a temporary hidden sheet', async () => {
    const updates: unknown[] = [];
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      if (url.includes('oauth2.googleapis.com/token')) return json({ access_token: 'token' });
      if (init?.method === 'GET') return json({ sheets: [] });
      const body = JSON.parse(String(init?.body)) as { requests: unknown[] };
      updates.push(...body.requests);
      return updates.length === 1
        ? json({ replies: [{ addSheet: { properties: { sheetId: 91 } } }] })
        : json({});
    });
    await new GoogleSheetsOutputAdapter({ fetch: fetchMock as unknown as typeof fetch }).test({
      destination: destination({}),
      credential,
    });
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ addSheet: { properties: { hidden: true } } });
    expect(updates[1]).toEqual({ deleteSheet: { sheetId: 91 } });
  });

  it('replaces a sheet only after staging all rows in a hidden sheet', async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    let batchUpdates = 0;
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      const method = init?.method ?? 'GET';
      if (url.includes('oauth2.googleapis.com/token')) return json({ access_token: 'token' });
      requests.push({
        url,
        method,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (method === 'GET') {
        return json({ sheets: [{ properties: { sheetId: 7, title: 'Data' } }] });
      }
      if (url.endsWith(':batchUpdate')) {
        batchUpdates += 1;
        if (batchUpdates === 1) {
          return json({ replies: [{ addSheet: { properties: { sheetId: 8 } } }] });
        }
      }
      return json({});
    });
    const result = await new GoogleSheetsOutputAdapter({
      fetch: fetchMock as unknown as typeof fetch,
    }).deliver({
      destination: destination({ mode: 'replace', includeSourceUrl: false }),
      taskId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      datasetSettings: { mode: 'upsert', keyFields: ['id'], detectRemoved: false },
      records: [
        { sourceUrl: 'https://example.com/1', data: { id: 1, name: 'one' } },
        { sourceUrl: 'https://example.com/2', data: { id: 2, name: 'two', late: true } },
      ],
      credential,
    });
    expect(result.delivered).toBe(2);
    const finalBatch = requests.filter((item) => item.url.endsWith(':batchUpdate')).at(-1)
      ?.body as {
      requests: unknown[];
    };
    expect(finalBatch.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ copyPaste: expect.any(Object) }),
        { deleteSheet: { sheetId: 8 } },
      ]),
    );
    expect(requests.filter((item) => item.method === 'PUT')).toHaveLength(2);
    expect(
      (requests.find((item) => item.method === 'PUT')?.body as { values: unknown[][] }).values,
    ).toEqual([['id', 'late', 'name']]);
  });

  it('makes append retries idempotent using the reserved run ID column', async () => {
    const runId = crypto.randomUUID();
    const batchRequests: unknown[] = [];
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = decodeURIComponent(String(request));
      if (url.includes('oauth2.googleapis.com/token')) return json({ access_token: 'token' });
      if (url.includes('?fields=sheets.properties')) {
        return json({ sheets: [{ properties: { sheetId: 7, title: 'Data' } }] });
      }
      if (url.endsWith(':batchUpdate')) {
        batchRequests.push(...(JSON.parse(String(init?.body)) as { requests: unknown[] }).requests);
        return json({});
      }
      if (url.includes('!1:1')) return json({ values: [['id', '__zhiyun_run_id']] });
      if (url.includes('!B2:B')) return json({ values: [[runId]] });
      throw new Error(`Unexpected Sheets request: ${init?.method ?? 'GET'} ${url}`);
    });
    const result = await new GoogleSheetsOutputAdapter({
      fetch: fetchMock as unknown as typeof fetch,
    }).deliver({
      destination: destination({ mode: 'append', fields: ['id'], includeSourceUrl: false }),
      taskId: crypto.randomUUID(),
      runId,
      datasetSettings: { mode: 'append', keyFields: [], detectRemoved: false },
      records: [{ sourceUrl: 'https://example.com/1', data: { id: 1 } }],
      credential,
    });
    expect(result).toEqual({ responseStatus: 200, delivered: 0 });
    expect(batchRequests).toContainEqual({
      updateDimensionProperties: {
        range: {
          sheetId: 7,
          dimension: 'COLUMNS',
          startIndex: 1,
          endIndex: 2,
        },
        properties: { hiddenByUser: true },
        fields: 'hiddenByUser',
      },
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(':append'))).toBe(false);
  });

  it('stages more than 500 append rows so a mid-upload retry cannot lose the tail', async () => {
    const runId = crypto.randomUUID();
    let failSecondStagingWrite = true;
    let stagingWrites = 0;
    let committed = false;
    let copyOperations = 0;
    let nextSheetId = 100;
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = decodeURIComponent(String(request));
      const method = init?.method ?? 'GET';
      if (url.includes('oauth2.googleapis.com/token')) return json({ access_token: 'token' });
      if (url.includes('?fields=sheets.properties')) {
        return json({ sheets: [{ properties: { sheetId: 7, title: 'Data' } }] });
      }
      if (method === 'GET' && url.includes('!1:1')) {
        return json({ values: [['id', '__zhiyun_run_id']] });
      }
      if (method === 'GET' && url.includes('!B2:B')) {
        return json({ values: committed ? [[runId]] : [] });
      }
      if (method === 'GET' && url.includes('!A:B')) {
        return json({ values: [['id', '__zhiyun_run_id']] });
      }
      if (method === 'PUT' && url.includes('__zhiyun_append_')) {
        stagingWrites += 1;
        if (failSecondStagingWrite && stagingWrites === 2) {
          failSecondStagingWrite = false;
          return json({ error: { message: 'injected staging failure' } }, 403);
        }
        return json({});
      }
      if (url.endsWith(':batchUpdate')) {
        const requests = (JSON.parse(String(init?.body)) as { requests: Record<string, unknown>[] })
          .requests;
        const add = requests.find((item) => item.addSheet) as
          { addSheet: Record<string, unknown> } | undefined;
        if (add) {
          nextSheetId += 1;
          return json({ replies: [{ addSheet: { properties: { sheetId: nextSheetId } } }] });
        }
        if (requests.some((item) => item.copyPaste)) {
          copyOperations += 1;
          committed = true;
        }
        return json({});
      }
      throw new Error(`Unexpected Sheets request: ${method} ${url}`);
    });
    const adapter = new GoogleSheetsOutputAdapter({
      fetch: fetchMock as unknown as typeof fetch,
    });
    const delivery = () =>
      adapter.deliver({
        destination: destination({ mode: 'append', fields: ['id'], includeSourceUrl: false }),
        taskId: crypto.randomUUID(),
        runId,
        datasetSettings: { mode: 'append', keyFields: [], detectRemoved: false },
        records: Array.from({ length: 601 }, (_, index) => ({
          sourceUrl: `https://example.com/${index}`,
          data: { id: index },
        })),
        credential,
      });

    await expect(delivery()).rejects.toThrow('injected staging failure');
    expect(committed).toBe(false);
    expect(copyOperations).toBe(0);

    await expect(delivery()).resolves.toEqual({ responseStatus: 200, delivered: 601 });
    expect(committed).toBe(true);
    expect(copyOperations).toBe(1);
    await expect(delivery()).resolves.toEqual({ responseStatus: 200, delivered: 0 });
    expect(copyOperations).toBe(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes(':append'))).toBe(false);
  });

  it.each([
    ['snapshot', 'replace'],
    ['upsert', 'replace'],
    ['append', 'append'],
  ] as const)('resolves auto mode for a %s dataset as %s', async (datasetMode, expectedMode) => {
    const requests: string[] = [];
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = decodeURIComponent(String(request));
      requests.push(url);
      if (url.includes('oauth2.googleapis.com/token')) return json({ access_token: 'token' });
      if (url.includes('?fields=sheets.properties')) {
        return json({ sheets: [{ properties: { sheetId: 7, title: 'Data' } }] });
      }
      if (url.includes('!1:1')) return json({ values: [['id', '__zhiyun_run_id']] });
      if (url.includes('!B2:B')) return json({ values: [['already-delivered']] });
      if (url.endsWith(':batchUpdate')) {
        const body = JSON.parse(String(init?.body)) as { requests: Record<string, unknown>[] };
        if (body.requests.some((item) => item.addSheet)) {
          return json({ replies: [{ addSheet: { properties: { sheetId: 8 } } }] });
        }
        return json({});
      }
      if (init?.method === 'PUT') return json({});
      throw new Error(`Unexpected Sheets request: ${init?.method ?? 'GET'} ${url}`);
    });
    await new GoogleSheetsOutputAdapter({ fetch: fetchMock as unknown as typeof fetch }).deliver({
      destination: destination({ mode: 'auto', fields: ['id'], includeSourceUrl: false }),
      taskId: crypto.randomUUID(),
      runId: 'already-delivered',
      datasetSettings: { mode: datasetMode, keyFields: [], detectRemoved: false },
      records: [],
      credential,
    });
    expect(requests.some((url) => url.includes('!B2:B'))).toBe(expectedMode === 'append');
  });

  it('retries quota responses with backoff', async () => {
    const sleeps: number[] = [];
    let metadataRequests = 0;
    let batchRequests = 0;
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      if (url.includes('oauth2.googleapis.com/token')) return json({ access_token: 'token' });
      if (init?.method === 'GET') {
        metadataRequests += 1;
        if (metadataRequests === 1) {
          return json({ error: { message: 'quota exceeded' } }, 429);
        }
        return json({ sheets: [] });
      }
      batchRequests += 1;
      return batchRequests === 1
        ? json({ replies: [{ addSheet: { properties: { sheetId: 91 } } }] })
        : json({});
    });
    await new GoogleSheetsOutputAdapter({
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async (milliseconds) => void sleeps.push(milliseconds),
      random: () => 0,
    }).test({ destination: destination({}), credential });
    expect(metadataRequests).toBe(2);
    expect(sleeps).toEqual([500]);
  });

  it.each([
    [403, 'permission denied'],
    [400, 'cell limit exceeded'],
  ])('does not retry permanent HTTP %i errors', async (status, message) => {
    let metadataRequests = 0;
    const sleep = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      if (String(request).includes('oauth2.googleapis.com/token')) {
        return json({ access_token: 'token' });
      }
      if (init?.method === 'GET') {
        metadataRequests += 1;
        return json({ error: { message } }, status);
      }
      throw new Error('Permanent metadata errors must not continue to writes');
    });
    await expect(
      new GoogleSheetsOutputAdapter({
        fetch: fetchMock as unknown as typeof fetch,
        sleep,
      }).test({ destination: destination({}), credential }),
    ).rejects.toThrow(message);
    expect(metadataRequests).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('extracts only the display-safe service-account email', () => {
    const email = googleServiceAccountClientEmail(credential);
    expect(email).toBe('zhiyun@example-project.iam.gserviceaccount.com');
    expect(email).not.toContain('PRIVATE KEY');
  });

  it('rejects invalid configuration and credentials before delivery', async () => {
    const adapter = new GoogleSheetsOutputAdapter({ fetch: vi.fn() as unknown as typeof fetch });
    await expect(
      adapter.test({ destination: destination({ sheetName: 'bad/name' }), credential }),
    ).rejects.toThrow('valid Google Sheets sheet name');
    await expect(
      adapter.test({ destination: destination({}), credential: { serviceAccountJson: '{}' } }),
    ).rejects.toThrow('client_email');
  });
});
