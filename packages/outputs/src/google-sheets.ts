import { createSign, randomUUID } from 'node:crypto';
import { ExportError } from '@zhiyun/contracts';
import { booleanConfig, parseFields, prepareTabularRows } from './serialization.js';
import type { OutputAdapter, OutputDeliveryInput, OutputDeliveryResult } from './types.js';

interface GoogleSheetsConfig {
  spreadsheetId: string;
  sheetName: string;
  mode: 'replace' | 'append';
  fields: string[];
  includeSourceUrl: boolean;
}

interface ServiceAccountCredential {
  clientEmail: string;
  privateKey: string;
}

interface SheetProperties {
  sheetId: number;
  title: string;
}

interface GoogleSheetsAdapterOptions {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseConfig(
  input: Pick<OutputDeliveryInput, 'destination'> &
    Partial<Pick<OutputDeliveryInput, 'datasetSettings'>>,
): GoogleSheetsConfig {
  const config = input.destination.config;
  const spreadsheetId = typeof config.spreadsheetId === 'string' ? config.spreadsheetId.trim() : '';
  if (!/^[A-Za-z0-9_-]{10,}$/.test(spreadsheetId)) {
    throw new ExportError('A valid Google Sheets spreadsheet ID is required');
  }
  const sheetName = typeof config.sheetName === 'string' ? config.sheetName.trim() : '';
  if (
    !sheetName ||
    sheetName.length > 100 ||
    ['[', ']', '*', '?', ':', '/', '\\'].some((character) => sheetName.includes(character))
  ) {
    throw new ExportError('A valid Google Sheets sheet name is required');
  }
  const configuredMode = config.mode ?? 'auto';
  if (configuredMode !== 'auto' && configuredMode !== 'replace' && configuredMode !== 'append') {
    throw new ExportError('Google Sheets mode must be auto, replace, or append');
  }
  const mode =
    configuredMode === 'auto'
      ? input.datasetSettings?.mode === 'append'
        ? 'append'
        : 'replace'
      : configuredMode;
  return {
    spreadsheetId,
    sheetName,
    mode,
    fields: parseFields(config.fields ?? config.columns),
    includeSourceUrl: booleanConfig(config.includeSourceUrl, true),
  };
}

function serviceAccountObject(value: unknown): Record<string, unknown> {
  const outer = objectValue(value);
  let candidate: unknown = outer.serviceAccountJson ?? outer.serviceAccount ?? value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      throw new ExportError('Google service-account JSON is invalid');
    }
  }
  return objectValue(candidate);
}

/** Extracts the only non-secret service-account field safe to expose in destination views. */
export function googleServiceAccountClientEmail(value: unknown): string {
  const credential = serviceAccountObject(value);
  const clientEmail = credential.client_email;
  const privateKey = credential.private_key;
  if (typeof clientEmail !== 'string' || !clientEmail.includes('@')) {
    throw new ExportError('Google service-account client_email is required');
  }
  if (typeof privateKey !== 'string' || !privateKey.includes('BEGIN PRIVATE KEY')) {
    throw new ExportError('Google service-account private_key is required');
  }
  return clientEmail;
}

function parseCredential(value: unknown): ServiceAccountCredential {
  const credential = serviceAccountObject(value);
  return {
    clientEmail: googleServiceAccountClientEmail(value),
    privateKey: credential.private_key as string,
  };
}

function base64Url(value: string | Buffer) {
  return Buffer.from(value).toString('base64url');
}

function quoteSheetName(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function columnName(index: number) {
  let value = index + 1;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function responseMessage(payload: unknown, status: number) {
  const error = objectValue(objectValue(payload).error);
  return typeof error.message === 'string'
    ? `Google Sheets returned HTTP ${status}: ${error.message}`
    : `Google Sheets returned HTTP ${status}`;
}

async function defaultSleep(milliseconds: number, signal?: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Output delivery aborted'));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

export class GoogleSheetsOutputAdapter implements OutputAdapter {
  readonly type = 'google-sheets' as const;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly #random: () => number;

  constructor(options: GoogleSheetsAdapterOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
  }

  async #accessToken(value: unknown, signal?: AbortSignal) {
    const credential = parseCredential(value);
    const issuedAt = Math.floor(this.#now() / 1_000);
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64Url(
      JSON.stringify({
        iss: credential.clientEmail,
        scope: 'https://www.googleapis.com/auth/spreadsheets',
        aud: 'https://oauth2.googleapis.com/token',
        iat: issuedAt,
        exp: issuedAt + 3_600,
      }),
    );
    const unsigned = `${header}.${claims}`;
    let signature: Buffer;
    try {
      signature = createSign('RSA-SHA256').update(unsigned).sign(credential.privateKey);
    } catch {
      throw new ExportError('Google service-account private_key could not sign a JWT');
    }
    const assertion = `${unsigned}.${base64Url(signature)}`;
    const response = await this.#fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      ...(signal ? { signal } : {}),
    });
    const payload = (await response.json().catch(() => ({}))) as unknown;
    const token = objectValue(payload).access_token;
    if (!response.ok || typeof token !== 'string' || !token) {
      throw new ExportError(responseMessage(payload, response.status));
    }
    return token;
  }

  async #request(
    token: string,
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const retryable = new Set([429, 500, 502, 503, 504]);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await this.#fetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...init.headers,
        },
        ...(signal ? { signal } : {}),
      });
      const payload = (await response.json().catch(() => ({}))) as unknown;
      if (response.ok) return objectValue(payload);
      if (!retryable.has(response.status) || attempt === 3) {
        throw new ExportError(responseMessage(payload, response.status));
      }
      const retryAfter = Number(response.headers.get('retry-after')) * 1_000;
      const exponential = Math.min(8_000, 500 * 2 ** attempt);
      await this.#sleep(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter
          : exponential + Math.floor(this.#random() * 250),
        signal,
      );
    }
    throw new ExportError('Google Sheets request exhausted retries');
  }

  #base(config: GoogleSheetsConfig) {
    return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.spreadsheetId)}`;
  }

  async #metadata(token: string, config: GoogleSheetsConfig, signal?: AbortSignal) {
    const payload = await this.#request(
      token,
      `${this.#base(config)}?fields=sheets.properties(sheetId,title)`,
      { method: 'GET' },
      signal,
    );
    const sheets = Array.isArray(payload.sheets) ? payload.sheets : [];
    return sheets.flatMap((sheet): SheetProperties[] => {
      const properties = objectValue(objectValue(sheet).properties);
      return typeof properties.sheetId === 'number' && typeof properties.title === 'string'
        ? [{ sheetId: properties.sheetId, title: properties.title }]
        : [];
    });
  }

  async #batchUpdate(
    token: string,
    config: GoogleSheetsConfig,
    requests: unknown[],
    signal?: AbortSignal,
  ) {
    return this.#request(
      token,
      `${this.#base(config)}:batchUpdate`,
      { method: 'POST', body: JSON.stringify({ requests }) },
      signal,
    );
  }

  async #addSheet(
    token: string,
    config: GoogleSheetsConfig,
    title: string,
    hidden: boolean,
    signal?: AbortSignal,
  ) {
    const payload = await this.#batchUpdate(
      token,
      config,
      [{ addSheet: { properties: { title, hidden } } }],
      signal,
    );
    const replies = Array.isArray(payload.replies) ? payload.replies : [];
    const properties = objectValue(objectValue(objectValue(replies[0]).addSheet).properties);
    if (typeof properties.sheetId !== 'number') {
      throw new ExportError('Google Sheets did not return the created sheet ID');
    }
    return properties.sheetId;
  }

  async #values(token: string, config: GoogleSheetsConfig, range: string, signal?: AbortSignal) {
    const payload = await this.#request(
      token,
      `${this.#base(config)}/values/${encodeURIComponent(range)}?majorDimension=ROWS`,
      { method: 'GET' },
      signal,
    );
    return Array.isArray(payload.values) ? (payload.values as unknown[][]) : [];
  }

  async #putValues(
    token: string,
    config: GoogleSheetsConfig,
    range: string,
    values: unknown[][],
    signal?: AbortSignal,
  ) {
    await this.#request(
      token,
      `${this.#base(config)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
      { method: 'PUT', body: JSON.stringify({ range, majorDimension: 'ROWS', values }) },
      signal,
    );
  }

  async test(input: Pick<OutputDeliveryInput, 'destination' | 'credential' | 'signal'>) {
    const config = parseConfig(input);
    const token = await this.#accessToken(input.credential, input.signal);
    await this.#metadata(token, config, input.signal);
    const title = `__zhiyun_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    let sheetId: number | undefined;
    try {
      sheetId = await this.#addSheet(token, config, title, true, input.signal);
    } finally {
      if (sheetId !== undefined) {
        await this.#batchUpdate(token, config, [{ deleteSheet: { sheetId } }], input.signal);
      }
    }
  }

  async deliver(input: OutputDeliveryInput): Promise<OutputDeliveryResult> {
    const config = parseConfig(input);
    const token = await this.#accessToken(input.credential, input.signal);
    const prepared = await prepareTabularRows(
      input.records,
      config.fields,
      config.includeSourceUrl,
      config.mode === 'append' ? input.runId : undefined,
      input.signal,
    );
    try {
      if (prepared.fields.length === 0) throw new ExportError('Google Sheets output has no fields');
      const sheets = await this.#metadata(token, config, input.signal);
      let target = sheets.find((sheet) => sheet.title === config.sheetName);
      if (!target) {
        target = {
          title: config.sheetName,
          sheetId: await this.#addSheet(token, config, config.sheetName, false, input.signal),
        };
      }

      if (config.mode === 'replace') {
        return await this.#replace(token, config, target, prepared, input.signal);
      }
      return await this.#append(token, config, target, prepared, input.runId, input.signal);
    } finally {
      await prepared.cleanup();
    }
  }

  async #replace(
    token: string,
    config: GoogleSheetsConfig,
    target: SheetProperties,
    prepared: Awaited<ReturnType<typeof prepareTabularRows>>,
    signal?: AbortSignal,
  ): Promise<OutputDeliveryResult> {
    const title = `__zhiyun_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
    const tempSheetId = await this.#addSheet(token, config, title, true, signal);
    let delivered = 0;
    try {
      await this.#putValues(
        token,
        config,
        `${quoteSheetName(title)}!A1`,
        [prepared.fields],
        signal,
      );
      let row = 2;
      let group: unknown[][] = [];
      const flush = async () => {
        if (group.length === 0) return;
        await this.#putValues(token, config, `${quoteSheetName(title)}!A${row}`, group, signal);
        row += group.length;
        delivered += group.length;
        group = [];
      };
      for await (const values of prepared.rows) {
        group.push(values);
        if (group.length >= 500) await flush();
      }
      await flush();
      await this.#batchUpdate(
        token,
        config,
        [
          {
            updateSheetProperties: {
              properties: {
                sheetId: target.sheetId,
                gridProperties: {
                  rowCount: Math.max(1, delivered + 1),
                  columnCount: Math.max(1, prepared.fields.length),
                },
              },
              fields: 'gridProperties(rowCount,columnCount)',
            },
          },
          {
            updateCells: {
              range: { sheetId: target.sheetId },
              fields: 'userEnteredValue',
            },
          },
          {
            copyPaste: {
              source: {
                sheetId: tempSheetId,
                startRowIndex: 0,
                endRowIndex: delivered + 1,
                startColumnIndex: 0,
                endColumnIndex: prepared.fields.length,
              },
              destination: {
                sheetId: target.sheetId,
                startRowIndex: 0,
                endRowIndex: delivered + 1,
                startColumnIndex: 0,
                endColumnIndex: prepared.fields.length,
              },
              pasteType: 'PASTE_NORMAL',
            },
          },
          { deleteSheet: { sheetId: tempSheetId } },
        ],
        signal,
      );
      return { responseStatus: 200, delivered };
    } catch (error) {
      await this.#batchUpdate(
        token,
        config,
        [{ deleteSheet: { sheetId: tempSheetId } }],
        signal,
      ).catch(() => undefined);
      throw error;
    }
  }

  async #append(
    token: string,
    config: GoogleSheetsConfig,
    target: SheetProperties,
    prepared: Awaited<ReturnType<typeof prepareTabularRows>>,
    runId: string,
    signal?: AbortSignal,
  ): Promise<OutputDeliveryResult> {
    const title = quoteSheetName(config.sheetName);
    const existingRows = await this.#values(token, config, `${title}!1:1`, signal);
    let header = (existingRows[0] ?? []).map(String);
    if (header.length === 0) {
      header = [...prepared.fields];
      await this.#putValues(token, config, `${title}!A1`, [header], signal);
    } else {
      const missing = prepared.fields.filter((field) => !header.includes(field));
      if (missing.length > 0) {
        header = [...header, ...missing];
        await this.#putValues(token, config, `${title}!A1`, [header], signal);
      }
    }
    const runColumn = header.indexOf('__zhiyun_run_id');
    if (runColumn < 0)
      throw new ExportError('Google Sheets append output is missing its run ID column');
    await this.#batchUpdate(
      token,
      config,
      [
        {
          updateDimensionProperties: {
            range: {
              sheetId: target.sheetId,
              dimension: 'COLUMNS',
              startIndex: runColumn,
              endIndex: runColumn + 1,
            },
            properties: { hiddenByUser: true },
            fields: 'hiddenByUser',
          },
        },
      ],
      signal,
    );
    const runValues = await this.#values(
      token,
      config,
      `${title}!${columnName(runColumn)}2:${columnName(runColumn)}`,
      signal,
    );
    if (runValues.some((row) => row[0] === runId)) {
      return { responseStatus: 200, delivered: 0 };
    }

    const preparedIndexes = new Map(prepared.fields.map((field, index) => [field, index]));
    const stagingTitle = `__zhiyun_append_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const stagingSheetId = await this.#addSheet(token, config, stagingTitle, true, signal);
    let delivered = 0;
    let stagingRow = 1;
    let group: unknown[][] = [];
    const flush = async () => {
      if (group.length === 0) return;
      await this.#putValues(
        token,
        config,
        `${quoteSheetName(stagingTitle)}!A${stagingRow}`,
        group,
        signal,
      );
      stagingRow += group.length;
      delivered += group.length;
      group = [];
    };
    try {
      for await (const row of prepared.rows) {
        group.push(header.map((field) => row[preparedIndexes.get(field) ?? -1] ?? null));
        if (group.length >= 500) await flush();
      }
      await flush();
      if (delivered === 0) {
        await this.#batchUpdate(
          token,
          config,
          [{ deleteSheet: { sheetId: stagingSheetId } }],
          signal,
        );
        return { responseStatus: 200, delivered: 0 };
      }
      const targetValues = await this.#values(
        token,
        config,
        `${title}!A:${columnName(header.length - 1)}`,
        signal,
      );
      const destinationStartRowIndex = Math.max(1, targetValues.length);
      await this.#batchUpdate(
        token,
        config,
        [
          {
            updateSheetProperties: {
              properties: {
                sheetId: target.sheetId,
                gridProperties: {
                  rowCount: destinationStartRowIndex + delivered,
                  columnCount: Math.max(1, header.length),
                },
              },
              fields: 'gridProperties(rowCount,columnCount)',
            },
          },
          {
            copyPaste: {
              source: {
                sheetId: stagingSheetId,
                startRowIndex: 0,
                endRowIndex: delivered,
                startColumnIndex: 0,
                endColumnIndex: header.length,
              },
              destination: {
                sheetId: target.sheetId,
                startRowIndex: destinationStartRowIndex,
                endRowIndex: destinationStartRowIndex + delivered,
                startColumnIndex: 0,
                endColumnIndex: header.length,
              },
              pasteType: 'PASTE_NORMAL',
            },
          },
          { deleteSheet: { sheetId: stagingSheetId } },
        ],
        signal,
      );
      return { responseStatus: 200, delivered };
    } catch (error) {
      await this.#batchUpdate(
        token,
        config,
        [{ deleteSheet: { sheetId: stagingSheetId } }],
        signal,
      ).catch(() => undefined);
      throw error;
    }
  }
}
