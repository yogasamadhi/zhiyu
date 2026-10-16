import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { ownRuntimeEffect } from '@zhiyun/runtime-contracts';
import { buildDesktopRuntime, openApiDocument, type Level2Runtime } from '../src/index.js';

const directories: string[] = [];
const runtimes: Level2Runtime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Cordis production composition', () => {
  it.each(['desktop-studio', 'safe', 'test', 'e2e', 'identity-test'])(
    'boots %s through packaged Include and disposes the complete tree',
    async (profileId) => {
      const dataDirectory = await mkdtemp(join(tmpdir(), 'zhiyun-cordis-profile-'));
      directories.push(dataDirectory);
      const runtime = await buildDesktopRuntime(
        {
          dataDirectory,
          hostBaseUrl: 'http://127.0.0.1:1',
          hostToken: 'fixture',
          schedulingEnvironment: { suspended: false, online: true },
          hostedAi: {
            enabled: () => false,
            request: () => Promise.reject(new Error('Unexpected hosted request')),
            configuration: () => ({
              provider: 'hosted',
              model: 'fixture',
              configuration: 'fixture',
            }),
          },
          host: {
            metadata: {
              runtimeId: 'fixture',
              generation: 1,
              apiVersion: 'v2',
              mode: 'desktop',
              productVersion: '1.0.0',
              analyticsWorkerStatus: 'unavailable',
              startedAt: new Date().toISOString(),
            },
            capabilities: {
              platform: 'darwin',
              browser: true,
              cron: true,
              credentials: true,
              artifactSaveDialog: false,
              notifications: false,
              tray: false,
            },
          },
          ...(profileId === 'identity-test'
            ? { identity: { options: { bootstrapToken: 'fixture-bootstrap-token-32-bytes-long' } } }
            : {}),
          openApiDocument: openApiDocument(profileId),
        },
        { profileId, sessionNonce: 'fixture', allowedOrigins: ['app://zhiyun'], logger: false },
      );
      runtimes.push(runtime);
      const response = await runtime.app.inject({ url: '/health' });
      expect(response.statusCode).toBe(200);
      await Promise.all([runtime.close(), runtime.close()]);
    },
  );

  it('waits for async cleanup when a background start fails and closes only once', async () => {
    const ctx = new Context();
    const failure = new Error('background failed');
    const close = vi.fn(async () => {
      await Promise.resolve();
    });
    ownRuntimeEffect(
      ctx,
      {
        start: () => {
          throw failure;
        },
        close,
      },
      'fixture',
    );
    await expect(ctx.parallel('runtime/start')).rejects.toMatchObject({ errors: [failure] });
    await ctx.parallel('runtime/stopping');
    await Promise.all([ctx.fiber.dispose(), ctx.fiber.dispose()]);
    expect(close).toHaveBeenCalledOnce();
  });
});
