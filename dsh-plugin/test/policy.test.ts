import { test, expect } from 'vitest';
import { mkdtemp, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiRequest, assertToolInput, containedFile } from '../src/host/policy.js';
const routes = [
  {
    operationId: 'getTask',
    method: 'GET',
    path: '/api/v2/tasks/{taskId}',
    ownerPluginId: 'collection',
  },
  {
    operationId: 'createSession',
    method: 'POST',
    path: '/api/v2/session',
    ownerPluginId: 'platform',
  },
];
test('catalogue authority rejects arbitrary operations, traversal, unexpected parameters and authentication headers', () => {
  expect(
    apiRequest(routes, { workspaceId: 'w', operationId: 'getTask', path: { taskId: 'id' } }).path,
  ).toBe('/api/v2/tasks/id');
  for (const input of [
    { operationId: 'createSession' },
    { operationId: 'http://evil' },
    { operationId: 'getTask', path: { taskId: '..' } },
    { operationId: 'getTask', path: { taskId: 'a', ignored: 'b' } },
    { operationId: 'getTask', path: { taskId: 'a' }, headers: { authorization: 'secret' } },
  ])
    expect(() => apiRequest(routes, { workspaceId: 'w', ...input })).toThrow();
});
test('tool bodies refuse credential values and accept reference bindings', () => {
  expect(() =>
    assertToolInput({ requestSettings: { headers: { Authorization: 'secret' } } }),
  ).toThrow();
  expect(() =>
    assertToolInput({ requestSettings: { cookies: [{ name: 'a', value: 'secret' }] } }),
  ).toThrow();
  expect(() =>
    assertToolInput({ credentialBindings: { headersRef: 'task-secret-headers-123' } }),
  ).not.toThrow();
});
test('exports reject absolute paths and symbolic links outside their selected root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zhiyun-export-test-'));
  try {
    expect(await containedFile(directory, 'corpus/data.jsonl')).toBe(
      join(await realpath(directory), 'corpus/data.jsonl'),
    );
    await symlink(tmpdir(), join(directory, 'escape'));
    await expect(containedFile(directory, 'escape/secret.txt')).rejects.toThrow();
    await expect(containedFile(directory, '../secret.txt')).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
