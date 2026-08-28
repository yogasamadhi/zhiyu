import { describe, expect, it } from 'vitest';
import { resolveUiContributions } from '../src/shell/contributions.js';

describe('UI Contribution Registry', () => {
  it('intersects Runtime IDs with the signed build-time registry', () => {
    const resolved = resolveUiContributions([
      'collection.route',
      'collection.navigation',
      'unknown.remote-code',
    ]);
    expect(resolved.routes.map(({ id }) => id)).toEqual(['collection.route']);
    expect(resolved.navigation.map(({ id }) => id)).toEqual(['collection.navigation']);
  });
});
