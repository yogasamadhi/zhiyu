import { describe, expect, it } from 'vitest';
import { createArchitectureCatalog } from '@zhiyun/kernel';
import { productProfiles, resolveProductGraph } from '../src/index.js';

describe('product profiles', () => {
  it('resolves every official profile', () => {
    for (const profile of productProfiles) {
      const graph = resolveProductGraph(profile.id);
      expect(graph.profile.id).toBe(profile.id);
      expect(graph.revision).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('assigns one owner to every desktop-studio contribution', () => {
    const catalog = createArchitectureCatalog(resolveProductGraph('desktop-studio'));
    expect(new Set(catalog.tables.map(({ id }) => id)).size).toBe(catalog.tables.length);
    expect(new Set(catalog.routes.map(({ id }) => id)).size).toBe(catalog.routes.length);
    expect(catalog.plugins.map(({ id }) => id)).not.toContain('legacy.runtime');
  });
});
