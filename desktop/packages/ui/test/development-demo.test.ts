import { describe, expect, it } from 'vitest';
import { resolveDevelopmentFixture } from '../src/development-demo.js';

describe('development fixture visibility', () => {
  it('never exposes a configured fixture in production', () => {
    expect(resolveDevelopmentFixture(false, 'http://127.0.0.1:45100')).toBeUndefined();
  });

  it('requires an explicit URL in development and normalizes a trailing slash', () => {
    expect(resolveDevelopmentFixture(true, undefined)).toBeUndefined();
    expect(resolveDevelopmentFixture(true, 'http://127.0.0.1:45100/')).toBe(
      'http://127.0.0.1:45100',
    );
  });
});
