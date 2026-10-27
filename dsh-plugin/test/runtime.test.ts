import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { test, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { allowedRoute } from '../src/host/policy.js';
import { RuntimeProcess } from '../src/host/runtime-process.js';
test('packaged Node, SQLite and Worker start without Electron and retain an isolated workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zhiyun-dsh-runtime-'));
  const fixture = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<article><h2>Owned browser</h2></article>');
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const runtime = new RuntimeProcess(
    {
      dataDirectory: join(directory, 'data'),
      workspaceDirectory: directory,
      resources: resolve('dsh-plugin/resources'),
      generation: 1,
      model: null,
    },
    async () => {
      throw new Error('Unexpected Host request');
    },
  );
  try {
    const ready = await runtime.start();
    const request = (path: string) =>
      fetch(ready.url + path, { headers: { authorization: `Bearer ${ready.token}` } });
    const metadata = (await (await request('/api/v2/runtime')).json()) as {
      profileId: string;
      analyticsWorkerStatus: string;
    };
    expect(metadata.profileId).toBe('dsh-studio');
    expect(metadata.analyticsWorkerStatus).toBe('ready');
    expect(
      ready.routes
        .filter(allowedRoute)
        .some((route) => ['recruitment', 'preferences', 'identity'].includes(route.ownerPluginId)),
    ).toBe(false);
    expect((await request('/api/v2/tasks')).status).toBe(200);
    const agentModel = { provider: 'agent-fixture', model: 'model-a' };
    const post = (path: string, body?: unknown, selected?: typeof agentModel) =>
      fetch(ready.url + path, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${ready.token}`,
          'idempotency-key': crypto.randomUUID(),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(selected
            ? { 'x-zhiyun-model': Buffer.from(JSON.stringify(selected)).toString('base64url') }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const created = await post('/api/v2/tasks', {
      name: 'Persisted model context',
      startUrl: `http://127.0.0.1:${address.port}/`,
      networkPolicy: { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
      instruction: 'Manual fixture',
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string };
    expect(
      (
        await post(`/api/v2/tasks/${task.id}/rules`, {
          name: 'Manual',
          generatedBy: 'human',
          definition: {
            type: 'css',
            container: 'article',
            fields: { name: { selector: 'h2', value: 'text', dataType: 'string' } },
          },
        })
      ).status,
    ).toBe(201);
    expect((await post(`/api/v2/tasks/${task.id}/runs`, undefined, agentModel)).status).toBe(202);
    const persistedContext = JSON.parse(
      execFileSync(
        resolve('dsh-plugin/resources/node/bin/node'),
        [
          '-e',
          'const D=require("better-sqlite3");const d=new D(process.argv[1],{readonly:true});const row=d.prepare("SELECT payload FROM platform_jobs WHERE type = ? ORDER BY created_at DESC LIMIT 1").get("collection.crawl.execute");process.stdout.write(JSON.stringify(JSON.parse(row.payload).__hostContext));d.close()',
          join(directory, 'data/zhiyun.sqlite3'),
        ],
        { cwd: resolve('dsh-plugin/resources/runtime'), encoding: 'utf8' },
      ),
    );
    expect(persistedContext.model).toEqual(agentModel);
    const inspection = await post('/api/v2/inspection-sessions', { taskId: task.id });
    expect(inspection.status).toBe(201);
    const pid = Number(await readFile(join(directory, 'data/.runtime.lock'), 'utf8'));
    const children = execFileSync('/usr/bin/pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .trim()
      .split(/\s+/)
      .map(Number);
    expect(children.length).toBeGreaterThanOrEqual(2);
    process.kill(pid, 'SIGKILL');
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let attempt = 0; attempt < 100 && children.some(alive); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(children.some(alive)).toBe(false);
    const restarted = await runtime.start();
    expect(restarted.generation).toBeGreaterThan(ready.generation);
    expect(
      (
        await fetch(restarted.url + '/api/v2/tasks', {
          headers: { authorization: `Bearer ${restarted.token}` },
        })
      ).status,
    ).toBe(200);
  } catch (error) {
    console.error(
      await readFile(join(directory, 'data/runtime-errors.log'), 'utf8').catch(
        () => 'No subprocess diagnostic',
      ),
    );
    throw error;
  } finally {
    await runtime.close();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 240_000);
