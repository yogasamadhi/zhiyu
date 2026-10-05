import { describe, expect, it } from 'vitest';
import { createWarningBuffer, appendWarnings, warningTotal } from '../src/warnings.js';

describe('bounded warning retention', () => {
  it('retains early messages and the total omission count over a large input', () => {
    const warnings = createWarningBuffer();
    for (let index = 0; index < 100_000; index++) warnings.push(`Field ${index} is invalid`);
    expect(warnings).toHaveLength(128);
    expect(warnings[0]).toBe('Field 0 is invalid');
    expect(warnings[126]).toBe('Field 126 is invalid');
    expect(warnings[127]).toBe('Additional warnings omitted: 99873');
    expect(warningTotal(warnings)).toBe(100_000);
    expect(JSON.parse(JSON.stringify(warnings))).toEqual([...warnings]);
  });
  it('bounds escaped Unicode/control-character storage without breaking Unicode', () => {
    const warnings = createWarningBuffer();
    for (let index = 0; index < 1000; index++)
      warnings.push(`${index}: ${'界🙂\u0000"\\'.repeat(1000)}`);
    expect(Buffer.byteLength(JSON.stringify(warnings))).toBeLessThanOrEqual(64 * 1024);
    expect(warnings.every((warning) => Buffer.byteLength(JSON.stringify(warning)) <= 512)).toBe(
      true,
    );
    expect(warnings[0]).toContain('界🙂');
    expect(warnings[0]).toMatch(/\.\.\.$/);
    expect(JSON.parse(JSON.stringify(warnings))).toEqual([...warnings]);
  });
  it('merges source omissions across pages without counting summaries as warnings', () => {
    const a = createWarningBuffer();
    const b = createWarningBuffer();
    const combined = createWarningBuffer();
    for (let index = 0; index < 1000; index++) {
      a.push('Page A');
      b.push('Page B');
    }
    appendWarnings(combined, ['Navigation fallback']);
    appendWarnings(combined, a);
    appendWarnings(combined, b);
    appendWarnings(combined, combined);
    expect(warningTotal(combined)).toBe(2001);
    expect(combined[127]).toBe('Additional warnings omitted: 1874');
    expect(combined[0]).toBe('Navigation fallback');
    expect(combined.filter((warning) => warning.startsWith('Additional warnings'))).toHaveLength(1);
    const transformed = createWarningBuffer();
    appendWarnings(transformed, combined, (value) => `${value}${'界🙂'.repeat(1000)}`);
    expect(warningTotal(transformed)).toBe(2001);
    expect(transformed[127]).toBe('Additional warnings omitted: 1874');
    expect(Buffer.byteLength(JSON.stringify(transformed))).toBeLessThanOrEqual(64 * 1024);
  });
});
