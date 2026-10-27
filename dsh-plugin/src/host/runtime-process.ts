import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { totalmem } from 'node:os';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import {
  readFile,
  access,
  mkdir,
  writeFile,
  realpath,
  readlink,
  cp,
  mkdtemp,
  rename,
  rm,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { RpcPeer } from '../shared/rpc.js';
import type { Bootstrap, ModelSelection, RpcMessage, RuntimeReady } from '../shared/protocol.js';

export class RuntimeProcess {
  private child: ChildProcess | undefined;
  private peer: RpcPeer | undefined;
  private ready: Promise<RuntimeReady> | undefined;
  private stopping: Promise<void> | undefined;
  private exit: Promise<void> | undefined;
  private closed = false;
  private launches = 0;
  private owned = new Set<number>();
  private diagnostics = '';
  constructor(
    readonly bootstrap: Bootstrap,
    private handle: (method: string, value: unknown, signal: AbortSignal) => Promise<unknown>,
  ) {}
  setDefaultModel(model: ModelSelection | null): void {
    if (JSON.stringify(model) === JSON.stringify(this.bootstrap.model)) return;
    this.bootstrap.model = model;
    if (this.ready)
      void this.ready
        .then(() => this.peer?.call('model.default', this.bootstrap.model))
        .catch(() => {});
  }
  start(): Promise<RuntimeReady> {
    if (this.closed) return Promise.reject(new Error('Runtime owner disposed'));
    return (this.ready ??= this.launch());
  }
  private async launch(): Promise<RuntimeReady> {
    const resources = this.bootstrap.resources;
    const node = join(resources, 'node/bin/node');
    await access(node);
    const manifest = JSON.parse(await readFile(join(resources, 'manifest.json'), 'utf8')) as {
      files: Record<string, string>;
      links?: Record<string, string>;
    };
    for (const [file, expected] of Object.entries(manifest.files)) {
      if (this.closed) throw new Error('Runtime owner disposed');
      if (file.startsWith('/') || file.split('/').includes('..'))
        throw new Error('Invalid resource manifest');
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(join(resources, file))) hash.update(chunk);
      if (hash.digest('hex') !== expected) throw new Error('Resource checksum mismatch');
    }
    const actualRoot = await realpath(resources);
    for (const [file, expected] of Object.entries(manifest.links ?? {})) {
      if (
        file.startsWith('/') ||
        file.split('/').includes('..') ||
        (await readlink(join(resources, file))) !== expected
      )
        throw new Error('Invalid resource link');
      const target = relative(actualRoot, await realpath(join(resources, file)));
      if (target.startsWith('..') || isAbsolute(target))
        throw new Error('Resource link escapes package');
    }
    if (this.closed) throw new Error('Runtime owner disposed');
    const digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
    const cacheRoot = join(dirname(this.bootstrap.dataDirectory), '.runtime');
    const execution = join(cacheRoot, digest);
    try {
      await access(join(execution, '.complete'));
    } catch {
      await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
      const staging = await mkdtemp(join(cacheRoot, 'preparing-'));
      try {
        await promisify(execFile)(
          '/usr/bin/tar',
          ['-xzf', join(resources, 'runtime/dependencies.tgz'), '-C', staging],
          { timeout: 120_000 },
        );
        for (const name of ['worker', 'playwright'])
          await promisify(execFile)(
            '/usr/bin/tar',
            ['-xzf', join(resources, `${name}.tgz`), '-C', staging],
            { timeout: 120_000 },
          );
        await cp(join(resources, 'runtime/runtime.mjs'), join(staging, 'runtime.mjs'));
        await cp(join(resources, 'runtime/profiles'), join(staging, 'profiles'), {
          recursive: true,
        });
        await writeFile(join(staging, '.complete'), digest, { mode: 0o600 });
        await rename(staging, execution).catch(async (error) => {
          if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
          await rm(staging, { recursive: true, force: true });
        });
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
    }
    if (this.closed) throw new Error('Runtime owner disposed');
    const env: Record<string, string> = {
      PATH: `${join(resources, 'node/bin')}:/usr/bin:/bin`,
      NODE_ENV: 'production',
      PLAYWRIGHT_BROWSERS_PATH: join(execution, 'playwright'),
      CRAWLEE_STORAGE_DIR: join(this.bootstrap.dataDirectory, 'crawlee'),
      CRAWLEE_MEMORY_MBYTES: String(
        Math.max(256, Math.min(4096, Math.floor(totalmem() / 4 / 1024 / 1024))),
      ),
    };
    for (const key of ['HOME', 'TMPDIR', 'LANG', 'SYSTEMROOT'])
      if (process.env[key]) env[key] = process.env[key]!;
    const child = (this.child = spawn(node, [join(execution, 'runtime.mjs')], {
      cwd: this.bootstrap.workspaceDirectory,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    }));
    const peer = (this.peer = new RpcPeer(
      (message) => {
        if (child.connected) child.send(message);
      },
      async (method, value, signal) => {
        if (method === 'process.track' || method === 'process.untrack') {
          const pid = (value as { pid: number }).pid;
          if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('Invalid child process');
          if (method === 'process.track') this.owned.add(pid);
          else this.owned.delete(pid);
          return true;
        }
        return this.handle(method, value, signal);
      },
    ));
    child.on('message', (message) => peer.receive(message as RpcMessage));
    // Raw subprocess output never reaches the model or the DSH transcript.
    child.stderr?.on('data', (chunk) => {
      this.diagnostics = (this.diagnostics + String(chunk)).slice(-65_536);
    });
    this.exit = new Promise((resolve) => {
      child.once('exit', () => {
        this.stopChildren(child.pid);
        peer.close();
        this.ready = undefined;
        resolve();
      });
      child.once('error', () => {
        peer.close();
        resolve();
      });
    });
    try {
      return await peer.call<RuntimeReady>(
        'bootstrap',
        {
          ...this.bootstrap,
          resources: execution,
          generation: this.bootstrap.generation + this.launches++,
        },
        AbortSignal.timeout(180_000),
      );
    } catch (error) {
      child.kill('SIGTERM');
      await mkdir(this.bootstrap.dataDirectory, { recursive: true });
      await writeFile(join(this.bootstrap.dataDirectory, 'runtime-errors.log'), this.diagnostics, {
        mode: 0o600,
      });
      throw error;
    }
  }
  private stopChildren(runtimePid?: number): void {
    for (const pid of [...this.owned, ...(runtimePid ? [runtimePid] : [])]) {
      try {
        process.kill(process.platform === 'win32' ? pid : -pid, 'SIGTERM');
      } catch {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* already exited */
        }
      }
    }
    this.owned.clear();
  }
  async close(): Promise<void> {
    this.closed = true;
    return (this.stopping ??= (async () => {
      const child = this.child;
      if (!child) return;
      try {
        if (child.connected) await this.peer?.call('shutdown', null, AbortSignal.timeout(15_000));
      } catch {
        /* shutdown may disconnect before its receipt */
      }
      const timeout = setTimeout(() => child.kill('SIGTERM'), 15_000);
      timeout.unref();
      const force = setTimeout(() => child.kill('SIGKILL'), 25_000);
      force.unref();
      await this.exit;
      clearTimeout(timeout);
      clearTimeout(force);
      this.peer?.close();
    })());
  }
}
