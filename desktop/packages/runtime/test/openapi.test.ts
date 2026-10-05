import { describe, expect, it } from 'vitest';
import { assertOpenApiPathParameters, openApiDocument } from '../src/openapi.js';

describe('runtime OpenAPI document', () => {
  it.each(['desktop-studio', 'identity-test', 'safe', 'test', 'e2e'])(
    '%s publishes exactly the path parameters present in each route template',
    (profileId) => {
      const document = openApiDocument(profileId);
      expect(() => assertOpenApiPathParameters(document.paths)).not.toThrow();
    },
  );

  it('rejects stale canonical path parameter names', () => {
    expect(() =>
      assertOpenApiPathParameters({
        '/api/v2/tasks/{taskId}': {
          get: {
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          },
        },
      }),
    ).toThrow('declares path parameters [id], expected [taskId]');
  });
});
