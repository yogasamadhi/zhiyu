import { test, expect } from 'vitest';
import { productTransport, type RemoteApi } from '../src/client/transport.js';

test('Remote transport preserves conditional responses and carries credential-free operation envelopes', async () => {
  const calls: unknown[] = [];
  const remote = {
    status: async () => ({
      generation: 1,
      routes: [
        {
          operationId: 'getTask',
          method: 'GET',
          path: '/api/v2/tasks/{taskId}',
          ownerPluginId: 'collection',
        },
      ],
    }),
    invoke: async (input: unknown) => {
      calls.push(input);
      return { status: 304, body: null, headers: { etag: '"2"' } };
    },
  } as unknown as RemoteApi;
  const transport = productTransport(remote, 'workspace-a');
  const result = await transport.fetch('/api/v2/tasks/task-a?limit=10', {
    headers: { authorization: 'private-runtime-token', 'if-none-match': '"2"' },
  });
  expect(result.status).toBe(304);
  expect(await result.text()).toBe('');
  expect(calls).toEqual([
    {
      workspaceId: 'workspace-a',
      operationId: 'getTask',
      path: { taskId: 'task-a' },
      query: { limit: '10' },
      headers: { 'if-none-match': '"2"' },
    },
  ]);
  await expect(transport.fetch('/api/v2/auth/admin')).rejects.toThrow('not available');
  expect('saveArtifact' in transport).toBe(false);
});

test('canceling an Artifact response releases the Remote stream and decodes bounded chunks', async () => {
  let released = false;
  const remote = {
    async *readArtifact(workspaceId: string, id: string) {
      expect(workspaceId).toBe('workspace-b');
      expect(id).toBe('artifact-a');
      try {
        yield { data: btoa('retained artifact') };
        yield { data: btoa('tail') };
      } finally {
        released = true;
      }
    },
  } as unknown as RemoteApi;
  const response = await productTransport(remote, 'workspace-b').fetch(
    '/api/v2/artifacts/artifact-a/content',
  );
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('retained artifact');
  await reader.cancel();
  expect(released).toBe(true);
});
