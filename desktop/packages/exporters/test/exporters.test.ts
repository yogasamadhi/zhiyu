import { describe, expect, it } from 'vitest';
import { DefaultDataExporter } from '../src/index.js';

describe('DefaultDataExporter', () => {
  const exporter = new DefaultDataExporter();
  const records = [{ name: '织云', formula: '=1+1' }];

  it.each(['csv', 'json', 'xlsx'] as const)('exports %s', async (format) => {
    const result = await exporter.export(records, { format, filename: 'records' });
    expect(result.data.byteLength).toBeGreaterThan(10);
    expect(result.filename).toBe(`records.${format}`);
  });

  it('streams CSV/JSON Lines without materializing the input', async () => {
    let consumed = 0;
    async function* input() {
      for (let index = 0; index < 3; index += 1) {
        consumed += 1;
        yield { id: index, value: `row-${index}` };
      }
    }
    const result = await exporter.exportStream(input(), {
      format: 'json',
      jsonMode: 'jsonl',
      filename: 'streamed',
    });
    expect(consumed).toBe(1);
    const chunks: Buffer[] = [];
    for await (const chunk of result.data) chunks.push(Buffer.from(chunk));
    expect(consumed).toBe(3);
    expect(Buffer.concat(chunks).toString('utf8').trim().split('\n')).toHaveLength(3);
    expect(result.filename).toBe('streamed.jsonl');
  });

  it('stops a streaming export when canceled', async () => {
    const controller = new AbortController();
    async function* input() {
      yield { id: 1 };
      controller.abort();
      yield { id: 2 };
    }
    const result = await exporter.exportStream(input(), {
      format: 'csv',
      signal: controller.signal,
    });
    await expect(async () => {
      for await (const _chunk of result.data) void _chunk;
    }).rejects.toMatchObject({ code: 'CANCELED' });
  });
});
