import { PassThrough } from 'node:stream';
import ExcelJS from 'exceljs';
import { ExportError, ZhiYunError } from '@zhiyun/shared';

export type ExportFormat = 'csv' | 'json' | 'xlsx';
export interface ExportOptions {
  format: ExportFormat;
  filename?: string;
  fields?: string[];
  bom?: boolean;
  jsonMode?: 'array' | 'jsonl';
  signal?: AbortSignal;
}
export interface ExportResult {
  data: Buffer;
  contentType: string;
  filename: string;
}
export interface ExportStreamResult {
  data: AsyncIterable<Uint8Array>;
  contentType: string;
  filename: string;
}
export interface DataExporter {
  export(records: unknown[], options: ExportOptions): Promise<ExportResult>;
  exportStream(
    records: AsyncIterable<unknown> | Iterable<unknown>,
    options: ExportOptions,
  ): Promise<ExportStreamResult>;
}

function cells(records: unknown[]): Array<Record<string, unknown>> {
  return records.filter(
    (record): record is Record<string, unknown> =>
      typeof record === 'object' && record !== null && !Array.isArray(record),
  );
}

function safeCell(value: unknown): string {
  const text =
    typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? '');
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function csvEscape(value: unknown): string {
  const text = safeCell(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function excelColumn(index: number): string {
  let value = index;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function checkCanceled(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new ZhiYunError('CANCELED', 'Export was canceled');
}

async function* textChunks(
  parts: AsyncIterable<string> | Iterable<string>,
  signal?: AbortSignal,
  targetBytes = 64 * 1024,
): AsyncGenerator<Uint8Array> {
  let buffered = '';
  for await (const part of parts) {
    checkCanceled(signal);
    buffered += part;
    if (Buffer.byteLength(buffered, 'utf8') >= targetBytes) {
      yield Buffer.from(buffered);
      buffered = '';
    }
  }
  if (buffered) yield Buffer.from(buffered);
}

async function* objectRecords(
  records: AsyncIterable<unknown> | Iterable<unknown>,
): AsyncGenerator<Record<string, unknown>> {
  for await (const record of records) {
    if (typeof record === 'object' && record !== null && !Array.isArray(record)) {
      yield record as Record<string, unknown>;
    }
  }
}

async function firstAndRest(records: AsyncIterator<Record<string, unknown>>) {
  const first = await records.next();
  return {
    first: first.done ? null : first.value,
    async *all() {
      if (!first.done) yield first.value;
      while (true) {
        const next = await records.next();
        if (next.done) return;
        yield next.value;
      }
    },
  };
}

export class DefaultDataExporter implements DataExporter {
  async export(records: unknown[], options: ExportOptions): Promise<ExportResult> {
    try {
      const streamed = await this.exportStream(cells(records), options);
      const chunks: Buffer[] = [];
      for await (const chunk of streamed.data) chunks.push(Buffer.from(chunk));
      return {
        data: Buffer.concat(chunks),
        contentType: streamed.contentType,
        filename: streamed.filename,
      };
    } catch (error) {
      if (error instanceof ZhiYunError) throw error;
      throw new ExportError('Could not export records', error);
    }
  }

  async exportStream(
    records: AsyncIterable<unknown> | Iterable<unknown>,
    options: ExportOptions,
  ): Promise<ExportStreamResult> {
    const base = options.filename ?? `zhiyun-export-${new Date().toISOString().slice(0, 10)}`;
    const iterator = objectRecords(records)[Symbol.asyncIterator]();
    const rows = await firstAndRest(iterator);
    const headers = options.fields?.length ? options.fields : Object.keys(rows.first ?? {});

    if (options.format === 'json') {
      const jsonMode = options.jsonMode ?? 'array';
      return {
        contentType:
          jsonMode === 'jsonl'
            ? 'application/x-ndjson; charset=utf-8'
            : 'application/json; charset=utf-8',
        filename: `${base}.${jsonMode === 'jsonl' ? 'jsonl' : 'json'}`,
        data: textChunks(
          (async function* () {
            if (jsonMode === 'array') yield '[';
            let index = 0;
            for await (const row of rows.all()) {
              checkCanceled(options.signal);
              const selected = Object.fromEntries(headers.map((header) => [header, row[header]]));
              if (jsonMode === 'jsonl') {
                yield `${JSON.stringify(selected)}\n`;
              } else {
                yield `${index === 0 ? '' : ','}\n${JSON.stringify(selected)}`;
              }
              index += 1;
            }
            if (jsonMode === 'array') yield `${index === 0 ? '' : '\n'}]`;
          })(),
          options.signal,
        ),
      };
    }

    if (options.format === 'csv') {
      return {
        contentType: 'text/csv; charset=utf-8',
        filename: `${base}.csv`,
        data: textChunks(
          (async function* () {
            yield `${options.bom === false ? '' : '\uFEFF'}${headers.map(csvEscape).join(',')}\r\n`;
            for await (const row of rows.all()) {
              yield `${headers.map((key) => csvEscape(row[key])).join(',')}\r\n`;
            }
          })(),
          options.signal,
        ),
      };
    }

    const stream = new PassThrough();
    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream,
      useStyles: false,
      useSharedStrings: false,
    });
    const produce = async () => {
      try {
        const maxRowsPerSheet = 1_048_575;
        let rowCount = 0;
        let sheetIndex = 0;
        let sheet: ReturnType<typeof workbook.addWorksheet> | undefined;
        const nextSheet = () => {
          sheet?.commit();
          sheetIndex += 1;
          rowCount = 0;
          sheet = workbook.addWorksheet(sheetIndex === 1 ? 'Records' : `Records ${sheetIndex}`);
          sheet.columns = headers.map((header) => ({ header, key: header, width: 22 }));
          if (headers.length > 0) sheet.autoFilter = `A1:${excelColumn(headers.length)}1`;
        };
        nextSheet();
        for await (const row of rows.all()) {
          checkCanceled(options.signal);
          if (rowCount >= maxRowsPerSheet) nextSheet();
          sheet!
            .addRow(Object.fromEntries(headers.map((header) => [header, safeCell(row[header])])))
            .commit();
          rowCount += 1;
        }
        sheet?.commit();
        await workbook.commit();
      } catch (error) {
        stream.destroy(
          error instanceof Error ? error : new ExportError('Could not export records'),
        );
      }
    };
    void produce();
    return {
      data: stream,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: `${base}.xlsx`,
    };
  }
}
