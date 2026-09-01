import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { PlatformJobQueue } from '@zhiyun/platform-core';
import type { OutputDestination, OutputRepository } from '../src/index.js';
import { registerOutputsHttp } from '../src/index.js';

const directories: string[] = [];
const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ format: 'pem', type: 'pkcs8' })
  .toString();
const serviceAccountJson = JSON.stringify({
  client_email: 'service@example-project.iam.gserviceaccount.com',
  private_key: privateKey,
});
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function outputDirectory() {
  const path = await mkdtemp(join(tmpdir(), 'zhiyun-output-http-'));
  directories.push(path);
  return path;
}

function localDestination(config: Record<string, unknown> = {}): OutputDestination {
  const timestamp = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: 'Local fixture',
    type: 'local-directory',
    config: {
      format: 'csv',
      pathTemplate: '{taskSlug}/{yyyy}/{mm}/{runId}.{ext}',
      updateLatest: true,
      ...config,
    },
    credentialRef: 'local-directory-ref',
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe('Outputs HTTP integration', () => {
  it('runs the adapter connection test instead of only resolving a credential', async () => {
    const root = await outputDirectory();
    const destination = localDestination();
    const app = Fastify();
    await registerOutputsHttp(app, {
      repository: {
        getDestination: async () => destination,
      } as unknown as OutputRepository,
      credentialStore: {
        put: async () => 'unused',
        resolve: async <T>() => ({ directoryPath: root }) as T,
        delete: async () => undefined,
      },
      jobs: {} as PlatformJobQueue,
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v2/output-destinations/${destination.id}/test`,
      headers: { 'idempotency-key': crypto.randomUUID() },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, destinationId: destination.id });
    expect(await readdir(root)).toEqual([]);
    await app.close();
  });

  it('returns a useful export problem when the real adapter test rejects configuration', async () => {
    const root = await outputDirectory();
    const destination = localDestination({ pathTemplate: '../escape.csv' });
    const app = Fastify();
    await registerOutputsHttp(app, {
      repository: {
        getDestination: async () => destination,
      } as unknown as OutputRepository,
      credentialStore: {
        put: async () => 'unused',
        resolve: async <T>() => ({ directoryPath: root }) as T,
        delete: async () => undefined,
      },
      jobs: {} as PlatformJobQueue,
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v2/output-destinations/${destination.id}/test`,
      headers: { 'idempotency-key': crypto.randomUUID() },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'EXPORT_ERROR' });
    await app.close();
  });

  it('accepts new destination inputs, applies shared defaults, and stores the right credential kind', async () => {
    const stored: Array<{ kind: string; value: unknown }> = [];
    let created: OutputDestination | undefined;
    const app = Fastify();
    await registerOutputsHttp(app, {
      repository: {
        createDestination: async (input: Parameters<OutputRepository['createDestination']>[0]) => {
          const timestamp = new Date().toISOString();
          created = {
            id: crypto.randomUUID(),
            ...input,
            createdAt: timestamp,
            updatedAt: timestamp,
          } as OutputDestination;
          return created;
        },
      } as unknown as OutputRepository,
      credentialStore: {
        put: async (kind, value) => {
          stored.push({ kind, value });
          return 'credential-ref';
        },
        resolve: async <T>() => ({}) as T,
        delete: async () => undefined,
      },
      jobs: {} as PlatformJobQueue,
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/v2/output-destinations',
      headers: { 'idempotency-key': crypto.randomUUID() },
      payload: {
        name: 'Sheets destination',
        type: 'google-sheets',
        config: {
          spreadsheetId: 'spreadsheet_123456789',
          harmlessLegacyOption: 'must-be-stripped',
        },
        credential: { serviceAccountJson },
        enabled: true,
      },
    });
    expect(response.statusCode).toBe(201);
    expect(stored).toEqual([
      {
        kind: 'output-google-sheets',
        value: { serviceAccountJson },
      },
    ]);
    expect(created).toMatchObject({
      type: 'google-sheets',
      credentialRef: 'credential-ref',
      config: {
        sheetName: 'Records',
        mode: 'auto',
        columns: [],
        clientEmail: 'service@example-project.iam.gserviceaccount.com',
      },
    });
    expect(JSON.stringify(response.json())).not.toContain('harmlessLegacyOption');
    expect(JSON.stringify(created)).not.toContain('harmlessLegacyOption');
    await app.close();
  });

  it('rejects recursively nested credentials in config before credential or repository writes', async () => {
    const current = localDestination();
    let credentialWrites = 0;
    let destinationWrites = 0;
    const app = Fastify();
    await registerOutputsHttp(app, {
      repository: {
        getDestination: async () => current,
        createDestination: async () => {
          destinationWrites += 1;
          return current;
        },
        updateDestination: async () => {
          destinationWrites += 1;
          return current;
        },
      } as unknown as OutputRepository,
      credentialStore: {
        put: async () => {
          credentialWrites += 1;
          return 'must-not-be-written';
        },
        resolve: async <T>() => ({}) as T,
        delete: async () => undefined,
      },
      jobs: {} as PlatformJobQueue,
    });

    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/v2/output-destinations',
      headers: { 'idempotency-key': crypto.randomUUID() },
      payload: {
        name: 'Unsafe S3',
        type: 's3',
        config: {
          bucket: 'fixture-bucket',
          nested: { private_key: 'must-never-be-stored' },
        },
        credential: { accessKeyId: 'stored-separately', secretAccessKey: 'stored-separately' },
        enabled: true,
      },
    });
    expect(createResponse.statusCode).toBe(400);
    expect(createResponse.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(JSON.stringify(createResponse.json())).not.toContain('must-never-be-stored');

    const updateResponse = await app.inject({
      method: 'PUT',
      url: `/api/v2/output-destinations/${current.id}`,
      headers: { 'idempotency-key': crypto.randomUUID() },
      payload: {
        config: {
          ...current.config,
          nested: [{ sessionToken: 'must-never-be-stored' }],
        },
      },
    });
    expect(updateResponse.statusCode).toBe(400);
    expect(updateResponse.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(credentialWrites).toBe(0);
    expect(destinationWrites).toBe(0);
    await app.close();
  });

  it('strips secrets and unknown fields from list and get responses defensively', async () => {
    const unsafe = localDestination({
      harmlessUnknown: 'legacy-value',
      secretAccessKey: 'legacy-secret',
      nested: { privateKey: 'legacy-private-key' },
    });
    const app = Fastify();
    await registerOutputsHttp(app, {
      repository: {
        listDestinations: async () => [unsafe],
        getDestination: async () => unsafe,
      } as unknown as OutputRepository,
      credentialStore: {
        put: async () => 'unused',
        resolve: async <T>() => ({}) as T,
        delete: async () => undefined,
      },
      jobs: {} as PlatformJobQueue,
    });

    for (const response of [
      await app.inject({ method: 'GET', url: '/api/v2/output-destinations' }),
      await app.inject({ method: 'GET', url: `/api/v2/output-destinations/${unsafe.id}` }),
    ]) {
      expect(response.statusCode).toBe(200);
      const serialized = JSON.stringify(response.json());
      expect(serialized).not.toContain('legacy-secret');
      expect(serialized).not.toContain('legacy-private-key');
      expect(serialized).not.toContain('harmlessUnknown');
    }
    await app.close();
  });

  it('uses the native directory selector when prompting a local destination', async () => {
    const destination = localDestination();
    const deleted: string[] = [];
    let credentialRef: string | null = destination.credentialRef;
    const app = Fastify();
    await registerOutputsHttp(app, {
      repository: {
        getDestination: async () => ({ ...destination, credentialRef }),
        updateDestination: async (
          _id: string,
          input: Parameters<OutputRepository['updateDestination']>[1],
        ) => {
          credentialRef = input.credentialRef ?? credentialRef;
          return { ...destination, credentialRef };
        },
      } as unknown as OutputRepository,
      credentialStore: {
        put: async () => 'unused',
        resolve: async <T>() => ({}) as T,
        delete: async (reference) => void deleted.push(reference),
      },
      jobs: {} as PlatformJobQueue,
      selectOutputDirectory: async () => ({ reference: 'new-directory-ref' }),
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v2/output-destinations/${destination.id}/credential/prompt`,
      headers: { 'idempotency-key': crypto.randomUUID() },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ canceled: false, credentialRef: 'new-directory-ref' });
    expect(deleted).toEqual(['local-directory-ref']);
    await app.close();
  });

  it('extracts a safe email after a native Google credential prompt', async () => {
    const timestamp = new Date().toISOString();
    let destination: OutputDestination = {
      id: crypto.randomUUID(),
      name: 'Sheets',
      type: 'google-sheets',
      config: {
        spreadsheetId: 'spreadsheet_123456789',
        sheetName: 'Records',
        mode: 'replace',
        columns: [],
      },
      credentialRef: null,
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const app = Fastify();
    await registerOutputsHttp(app, {
      repository: {
        getDestination: async () => destination,
        updateDestination: async (
          _id: string,
          input: Parameters<OutputRepository['updateDestination']>[1],
        ) => {
          destination = { ...destination, ...input } as OutputDestination;
          return destination;
        },
      } as unknown as OutputRepository,
      credentialStore: {
        put: async () => 'unused',
        resolve: async <T>() => ({ serviceAccountJson }) as T,
        delete: async () => undefined,
      },
      jobs: {} as PlatformJobQueue,
      promptCredential: async () => ({ reference: 'encrypted-google-ref' }),
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/v2/output-destinations/${destination.id}/credential/prompt`,
      headers: { 'idempotency-key': crypto.randomUUID() },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      credentialRef: 'encrypted-google-ref',
      config: { clientEmail: 'service@example-project.iam.gserviceaccount.com' },
    });
    expect(JSON.stringify(response.json())).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(destination)).not.toContain('private_key');
    await app.close();
  });
});
