import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const desktopRoot = resolve(import.meta.dirname, '..');

it.each(['http://127.0.0.1:45100', 'http://localhost:45109'])(
  'removes the development fixture %s from the actual production renderer',
  async (fixtureUrl) => {
    const output = await mkdtemp(join(tmpdir(), 'zhiyun-renderer-build-'));
    try {
      await execute('bun', ['--bun', 'vite', 'build', '--outDir', output], {
        cwd: desktopRoot,
        env: { ...process.env, NODE_ENV: 'production', VITE_FIXTURE_URL: fixtureUrl },
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const files = await readdir(output, { recursive: true });
      expect(files).toContain('index.html');
      expect(files.some((file) => /TaskEditorPage.*\.js$/u.test(file))).toBe(true);
      for (const file of files.filter((file) => /\.(?:css|html|js|json|map)$/u.test(file))) {
        const source = await readFile(join(output, file), 'utf8');
        expect(source.includes(fixtureUrl), file).toBe(false);
      }
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  },
  65_000,
);
