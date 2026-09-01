import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerStaticWeb } from '../src/static-web.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Headless static Web hosting', () => {
  it('serves assets and SPA routes without swallowing API or operational paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zhiyun-static-web-'));
    roots.push(root);
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'index.html'), '<!doctype html><main>ZhiYun</main>');
    await writeFile(join(root, 'assets/app.12345678.js'), 'globalThis.__zhiyun = true;');
    const app = Fastify();
    await registerStaticWeb(app, { roots: [root] });
    try {
      const index = await app.inject({ method: 'GET', url: '/' });
      expect(index.statusCode).toBe(200);
      expect(index.body).toContain('ZhiYun');
      expect(index.headers['cache-control']).toContain('no-store');

      const route = await app.inject({ method: 'GET', url: '/tasks/example' });
      expect(route.statusCode).toBe(200);
      expect(route.body).toContain('ZhiYun');

      const asset = await app.inject({ method: 'GET', url: '/assets/app.12345678.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-type']).toContain('text/javascript');
      expect(asset.headers['cache-control']).toContain('immutable');

      for (const url of ['/api/v2/missing', '/health/missing', '/ready/missing']) {
        const response = await app.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(404);
        expect(response.headers['content-type']).toContain('application/problem+json');
      }
      expect((await app.inject({ method: 'GET', url: '/assets/missing.js' })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('does not register a catch-all when no packaged Web build exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'zhiyun-static-empty-'));
    roots.push(root);
    const app = Fastify();
    expect(await registerStaticWeb(app, { roots: [root] })).toBeNull();
    await app.close();
  });
});
