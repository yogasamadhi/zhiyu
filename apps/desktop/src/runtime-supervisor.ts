import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { utilityProcess, type UtilityProcess } from 'electron';
import type { RuntimeBootstrap } from '@zhiyun/contracts';
import { createRuntimeEnvironment } from './runtime-environment.js';

interface SupervisorOptions {
  dataDirectory: string;
  hostBaseUrl: string;
  hostToken: string;
  browserResources?: string;
  rendererOrigin?: string;
  onReady(bootstrap: RuntimeBootstrap): void;
  onDegraded(reason: string): void;
}

interface ReadyMessage {
  type: 'ready';
  baseUrl: string;
  runtimeId: string;
  generation: number;
  apiVersion: 'v2';
}

interface NonceIssuedMessage {
  type: 'session-nonce-issued';
  requestId: string;
}

export class RuntimeSupervisor {
  private child: UtilityProcess | undefined;
  private generation = 0;
  private stopping = false;
  private restartTimes: number[] = [];
  private restartAttempt = 0;
  private sessionNonce = '';
  private currentBootstrap: RuntimeBootstrap | undefined;
  private readonly nonceWaiters = new Map<string, () => void>();

  constructor(private readonly options: SupervisorOptions) {}

  start(): void {
    this.stopping = false;
    this.spawn();
  }

  restart(): void {
    this.child?.kill();
    if (!this.child) this.spawn();
  }

  private spawn(): void {
    if (this.stopping) return;
    this.generation += 1;
    this.sessionNonce =
      crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    const runtimePath = join(
      fileURLToPath(new URL('.', import.meta.url)),
      'runtime',
      'utility-entry.js',
    );
    const child = utilityProcess.fork(runtimePath, [], {
      serviceName: 'ZhiYun Runtime',
      stdio: 'pipe',
      env: createRuntimeEnvironment(process.env, this.options.browserResources),
    });
    this.child = child;
    child.stdout?.on('data', (chunk) => process.stdout.write(`[runtime] ${String(chunk)}`));
    child.stderr?.on('data', (chunk) => process.stderr.write(`[runtime] ${String(chunk)}`));
    child.on('message', (message: unknown) => {
      const payload = message as
        ReadyMessage | NonceIssuedMessage | { type: 'fatal'; message: string };
      if (payload.type === 'ready') {
        this.restartAttempt = 0;
        this.currentBootstrap = {
          baseUrl: payload.baseUrl,
          sessionNonce: this.sessionNonce,
          runtimeId: payload.runtimeId,
          generation: payload.generation,
          apiVersion: payload.apiVersion,
        };
        this.options.onReady(this.currentBootstrap);
      } else if (payload.type === 'session-nonce-issued') {
        const requestId = payload.requestId;
        this.nonceWaiters.get(requestId)?.();
        this.nonceWaiters.delete(requestId);
      } else if (payload.type === 'fatal') {
        process.stderr.write(`[runtime] fatal: ${payload.message}\n`);
      }
    });
    child.once('spawn', () => {
      child.postMessage({
        type: 'bootstrap',
        dataDirectory: this.options.dataDirectory,
        hostBaseUrl: this.options.hostBaseUrl,
        hostToken: this.options.hostToken,
        sessionNonce: this.sessionNonce,
        generation: this.generation,
        ...(this.options.rendererOrigin ? { rendererOrigin: this.options.rendererOrigin } : {}),
        ...(this.options.browserResources
          ? { browserResources: this.options.browserResources }
          : {}),
        ai: {
          baseUrl: process.env.AI_BASE_URL,
          model: process.env.AI_MODEL,
          apiKeyRef: process.env.ZHIYUN_DESKTOP_AI_KEY_REF,
        },
      });
    });
    child.once('exit', () => {
      if (this.child === child) this.child = undefined;
      if (!this.stopping) this.scheduleRestart();
    });
  }

  async issueBootstrap(): Promise<RuntimeBootstrap> {
    if (!this.child || !this.currentBootstrap) throw new Error('Runtime is not ready');
    const nonce = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
    const requestId = crypto.randomUUID();
    const acknowledged = new Promise<void>((resolve) => this.nonceWaiters.set(requestId, resolve));
    this.child.postMessage({ type: 'issue-session-nonce', nonce, requestId });
    await Promise.race([
      acknowledged,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('Runtime did not acknowledge session nonce')), 5_000),
      ),
    ]);
    return { ...this.currentBootstrap, sessionNonce: nonce };
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const bootstrap = await this.issueBootstrap();
    const session = await fetch(`${bootstrap.baseUrl}/api/v2/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: bootstrap.sessionNonce }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!session.ok) throw new Error(`Runtime session failed: HTTP ${session.status}`);
    const { token } = (await session.json()) as { token: string };
    const response = await fetch(`${bootstrap.baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Runtime request failed: HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  private scheduleRestart(): void {
    const timestamp = Date.now();
    this.restartTimes = this.restartTimes.filter((value) => timestamp - value < 10 * 60_000);
    if (this.restartTimes.length >= 5) {
      this.options.onDegraded('Runtime restarted more than five times in ten minutes');
      return;
    }
    this.restartTimes.push(timestamp);
    const delays = [1_000, 2_000, 4_000, 8_000];
    const delay = delays[Math.min(this.restartAttempt, delays.length - 1)]!;
    this.restartAttempt += 1;
    setTimeout(() => this.spawn(), delay);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.postMessage({ type: 'shutdown' });
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 30_000)),
    ]);
    if (!graceful) {
      child.kill();
      await exited;
    }
    this.child = undefined;
    this.currentBootstrap = undefined;
  }

  diagnostics(): Record<string, unknown> {
    return {
      generation: this.generation,
      running: Boolean(this.child),
      pid: this.child?.pid,
      restartsInTenMinutes: this.restartTimes.length,
      degraded: !this.child && this.restartTimes.length >= 5,
    };
  }
}
