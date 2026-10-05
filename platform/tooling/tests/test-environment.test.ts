import { test, expect } from 'bun:test';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import {
  assertTestDatabase,
  availableTestPort,
  testEnvironment,
} from '../../../tooling/scripts/test-environment.js';
import { assertPortsAvailable } from '../../../tooling/scripts/development.js';

test('isolated environment removes credentials, real channels and caller data paths', () => {
  const environment = testEnvironment({
    PATH: '/test/bin',
    HOME: '/test/home',
    AI_API_KEY: 'sensitive-fixture',
    CUSTOM_MODEL_KEY: 'sensitive-fixture',
    CLOUD_SMTP_URL: 'sensitive-fixture',
    APPLE_ID: 'sensitive-fixture',
    CLOUD_DATABASE_URL: 'postgres://development/production',
    ZHIYUN_DATA_DIR: '/user/data',
    CLOUD_REAL_MESSAGES: 'true',
    NODE_ENV: 'production',
  });
  expect(environment.PATH).toBe('/test/bin');
  expect(environment.HOME).toBe('/test/home');
  expect(environment.NODE_ENV).toBe('test');
  expect(environment.CLOUD_MOCK_PAYMENTS).toBe('true');
  expect(environment.CLOUD_REAL_MESSAGES).toBe('false');
  expect(environment.AI_API_KEY).toBe('');
  expect(JSON.stringify(environment)).not.toContain('sensitive-fixture');
  expect(environment.CLOUD_DATABASE_URL).toBeUndefined();
  expect(environment.ZHIYUN_DATA_DIR).toBeUndefined();
});

test('destructive database targets require local hosts, exact suffixes and safe database names', () => {
  for (const url of [
    'postgres://test:fixture@127.0.0.1:65432/zhiyun_123_test',
    'postgresql://localhost/zhiyun_test',
    'postgres://[::1]/zhiyun_test',
  ])
    expect(assertTestDatabase(url).pathname).toEndWith('_test');
  expect(assertTestDatabase('postgres://localhost/zhiyun_123_e2e_test', 'e2e').pathname).toEndWith(
    '_e2e_test',
  );
  for (const url of [
    'postgres://localhost/zhiyun_cloud',
    'postgres://localhost/postgres',
    'postgres://example.com/zhiyun_test',
    'postgres://localhost/zhiyun_test/other',
    'postgres://localhost/zhiyun%2F_test',
    'postgres://localhost/zhiyun_test?host=example.com',
    'postgres://localhost/zhiyun_test#ignored',
    'file:///zhiyun_test',
    'invalid',
  ])
    expect(() => assertTestDatabase(url)).toThrow('Test database must be a local PostgreSQL');
  expect(() => assertTestDatabase('postgres://localhost/zhiyun_test', 'e2e')).toThrow();
});

test('safe port preflight refuses an occupied port and leaves its listener alive', async () => {
  const server = createServer((socket) => socket.end('still alive'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test listener unavailable');
  try {
    await expect(
      assertPortsAvailable([{ name: 'owned by another service', port: address.port }]),
    ).rejects.toThrow('已占用');
    expect(server.listening).toBe(true);
    await assertPortsAvailable([{ name: 'free test port', port: await availableTestPort() }]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('E2E seed rejects a development database before trying any connection', async () => {
  const child = Bun.spawn(['bun', '--no-env-file', 'platform/tooling/scripts/seed-e2e.ts'], {
    cwd: resolve(import.meta.dir, '../../..'),
    env: {
      ...testEnvironment(process.env),
      CLOUD_DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1:1/zhiyun_cloud',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, output] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code).not.toBe(0);
  expect(output).toContain('Test database must be a local PostgreSQL *_e2e_test database');
  expect(output).not.toContain('ECONNREFUSED');
});
