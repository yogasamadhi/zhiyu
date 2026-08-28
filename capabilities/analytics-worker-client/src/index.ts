import { mkdir, realpath } from 'node:fs/promises';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { components } from './openapi.generated.js';

export type WorkerJob = components['schemas']['WorkerJob'];
export type WorkerJobSubmission = components['schemas']['WorkerJobSubmission'];
export type WorkerMethodDescriptor = components['schemas']['MethodDescriptor'];
export type WorkerCapabilities = components['schemas']['WorkerCapabilities'];
export type WorkerVersion = components['schemas']['WorkerVersion'];
export type WorkerProblem = components['schemas']['Problem'];

export class AnalyticsWorkerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AnalyticsWorkerPrivateBootstrap {
  baseUrl: string;
  token: string;
  generation: number;
  protocolVersion: 'worker/v1';
  workerVersion: string;
}

export class AnalyticsWorkerClient {
  constructor(
    private readonly connection: AnalyticsWorkerPrivateBootstrap,
    private readonly defaultTimeoutMs = 30_000,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<T> {
    const response = await fetch(`${this.connection.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.connection.token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(timeoutMs ?? this.defaultTimeoutMs),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as WorkerProblem | undefined;
      throw new AnalyticsWorkerError(
        response.status,
        body?.code ?? 'WORKER_REQUEST_FAILED',
        body?.detail ?? `Analytics Worker request failed: HTTP ${response.status}`,
      );
    }
    return (await response.json()) as T;
  }

  health(): Promise<{ status: string }> {
    return this.request('/health', {}, 5_000);
  }

  version(): Promise<WorkerVersion> {
    return this.request('/worker/v1/version');
  }

  capabilities(): Promise<WorkerCapabilities> {
    return this.request('/worker/v1/capabilities');
  }

  methods(): Promise<WorkerMethodDescriptor[]> {
    return this.request('/worker/v1/methods');
  }

  submit(submission: WorkerJobSubmission): Promise<WorkerJob> {
    return this.request('/worker/v1/jobs', {
      method: 'POST',
      body: JSON.stringify(submission),
    });
  }

  job(jobId: string): Promise<WorkerJob> {
    return this.request(`/worker/v1/jobs/${encodeURIComponent(jobId)}`);
  }

  cancel(jobId: string): Promise<WorkerJob> {
    return this.request(`/worker/v1/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
  }

  async shutdown(): Promise<void> {
    await this.request('/worker/v1/shutdown', { method: 'POST' }, 5_000);
  }
}

export type AnalyticsWorkerSupervisorState =
  | { status: 'stopped'; generation: number }
  | { status: 'starting'; generation: number }
  | { status: 'ready'; generation: number; workerVersion: string; pid: number }
  | { status: 'degraded'; generation: number; reason: string };

export interface AnalyticsWorkerSupervisorOptions {
  command: string;
  args?: string[];
  workspaceRoot: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  maxRestarts?: number;
  restartWindowMs?: number;
  onStateChange?(state: AnalyticsWorkerSupervisorState): void;
  onLog?(stream: 'stdout' | 'stderr', message: string): void;
}

interface WorkerReadyLine {
  type: 'ready';
  baseUrl: string;
  generation: number;
  protocolVersion: 'worker/v1';
  workerVersion: string;
  pid: number;
}

const delay = (milliseconds: number) =>
  new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));

function validateReady(value: unknown, generation: number): WorkerReadyLine {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid Worker ready payload');
  const item = value as Record<string, unknown>;
  if (
    item.type !== 'ready' ||
    item.protocolVersion !== 'worker/v1' ||
    item.generation !== generation ||
    typeof item.baseUrl !== 'string' ||
    typeof item.workerVersion !== 'string' ||
    typeof item.pid !== 'number'
  ) {
    throw new Error('Worker ready payload does not match its bootstrap');
  }
  const endpoint = new URL(item.baseUrl);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port) {
    throw new Error('Worker must bind an ephemeral 127.0.0.1 port');
  }
  return item as unknown as WorkerReadyLine;
}

export class AnalyticsWorkerSupervisor {
  private child: ChildProcessWithoutNullStreams | undefined;
  private client: AnalyticsWorkerClient | undefined;
  private privateBootstrap: AnalyticsWorkerPrivateBootstrap | undefined;
  private generation = 0;
  private stopping = false;
  private startPromise: Promise<AnalyticsWorkerPrivateBootstrap> | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private restartTimes: number[] = [];

  constructor(private readonly options: AnalyticsWorkerSupervisorOptions) {}

  private publish(state: AnalyticsWorkerSupervisorState): void {
    this.options.onStateChange?.(state);
  }

  async start(): Promise<AnalyticsWorkerPrivateBootstrap> {
    this.stopping = false;
    this.startPromise ??= this.spawnWorker()
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        this.child?.kill('SIGKILL');
        this.child = undefined;
        this.client = undefined;
        this.privateBootstrap = undefined;
        if (!this.stopping) this.scheduleRestart(reason);
        throw error;
      })
      .finally(() => {
        this.startPromise = undefined;
      });
    return this.startPromise;
  }

  private async spawnWorker(): Promise<AnalyticsWorkerPrivateBootstrap> {
    this.generation += 1;
    const generation = this.generation;
    this.publish({ status: 'starting', generation });
    await mkdir(this.options.workspaceRoot, { recursive: true, mode: 0o700 });
    const workspaceRoot = await realpath(this.options.workspaceRoot);
    const token = randomBytes(48).toString('base64url');
    const child = spawn(this.options.command, this.options.args ?? [], {
      env: {
        ...process.env,
        ...this.options.env,
        ZHIYUN_WORKER_EXTERNAL_NETWORK: 'disabled',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.stdin.end(`${JSON.stringify({ token, generation, workspaceRoot })}\n`);
    let readyBuffer = '';
    let readyResolved = false;
    const ready = await new Promise<WorkerReadyLine>((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => {
        rejectReady(new Error('Analytics Worker did not become ready within the startup budget'));
        child.kill('SIGKILL');
      }, this.options.startupTimeoutMs ?? 20_000);
      const settle = (action: () => void) => {
        clearTimeout(timeout);
        action();
      };
      child.once('error', (error) => settle(() => rejectReady(error)));
      child.once('exit', (code, signal) => {
        if (!readyResolved) {
          settle(() =>
            rejectReady(
              new Error(`Analytics Worker exited before ready (code=${code}, signal=${signal})`),
            ),
          );
        }
      });
      child.stdout.on('data', (chunk: Buffer) => {
        if (readyResolved) {
          this.options.onLog?.('stdout', chunk.toString('utf8'));
          return;
        }
        readyBuffer += chunk.toString('utf8');
        if (Buffer.byteLength(readyBuffer, 'utf8') > 64 * 1024) {
          settle(() => rejectReady(new Error('Analytics Worker ready output exceeded 64KiB')));
          child.kill('SIGKILL');
          return;
        }
        const newline = readyBuffer.indexOf('\n');
        if (newline < 0) return;
        try {
          const payload = validateReady(JSON.parse(readyBuffer.slice(0, newline)), generation);
          readyResolved = true;
          const remainder = readyBuffer.slice(newline + 1);
          if (remainder) this.options.onLog?.('stdout', remainder);
          settle(() => resolveReady(payload));
        } catch (error) {
          settle(() => rejectReady(error instanceof Error ? error : new Error(String(error))));
          child.kill('SIGKILL');
        }
      });
      child.stderr.on('data', (chunk: Buffer) =>
        this.options.onLog?.('stderr', chunk.toString('utf8')),
      );
    });
    const bootstrap: AnalyticsWorkerPrivateBootstrap = {
      baseUrl: ready.baseUrl,
      token,
      generation,
      protocolVersion: ready.protocolVersion,
      workerVersion: ready.workerVersion,
    };
    const client = new AnalyticsWorkerClient(bootstrap);
    await client.health();
    if (this.child !== child) throw new Error('Analytics Worker was replaced during startup');
    this.privateBootstrap = bootstrap;
    this.client = client;
    this.publish({
      status: 'ready',
      generation,
      workerVersion: ready.workerVersion,
      pid: ready.pid,
    });
    child.once('exit', () => this.handleUnexpectedExit(child));
    return bootstrap;
  }

  private handleUnexpectedExit(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.client = undefined;
    this.privateBootstrap = undefined;
    if (this.stopping) return;
    this.scheduleRestart('Analytics Worker exited unexpectedly; restart scheduled');
  }

  private scheduleRestart(reason: string): void {
    if (this.restartTimer || this.stopping) return;
    const now = Date.now();
    const windowMs = this.options.restartWindowMs ?? 10 * 60_000;
    this.restartTimes = this.restartTimes.filter((timestamp) => now - timestamp < windowMs);
    const maximum = this.options.maxRestarts ?? 5;
    if (this.restartTimes.length >= maximum) {
      this.publish({
        status: 'degraded',
        generation: this.generation,
        reason: `Analytics Worker restarted ${maximum} times within its restart window`,
      });
      return;
    }
    this.restartTimes.push(now);
    this.publish({
      status: 'degraded',
      generation: this.generation,
      reason,
    });
    const backoff = [1_000, 2_000, 4_000, 8_000][Math.min(this.restartTimes.length - 1, 3)]!;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.start().catch(() => undefined);
    }, backoff);
    this.restartTimer.unref?.();
  }

  connection(): AnalyticsWorkerPrivateBootstrap | undefined {
    return this.privateBootstrap ? { ...this.privateBootstrap } : undefined;
  }

  diagnostics(): Record<string, unknown> {
    return {
      status: this.privateBootstrap ? 'ready' : this.child ? 'starting' : 'degraded',
      generation: this.generation,
      pid: this.child?.pid,
      workerVersion: this.privateBootstrap?.workerVersion,
      restartsInWindow: this.restartTimes.length,
    };
  }

  async cancelAndEnforce(jobId: string): Promise<WorkerJob> {
    const client = this.client;
    if (!client) throw new AnalyticsWorkerError(503, 'ANALYTICS_UNAVAILABLE', 'Worker unavailable');
    const canceling = await client.cancel(jobId);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const job = await client.job(jobId);
      if (['canceled', 'succeeded', 'failed'].includes(job.state)) return job;
      await delay(100);
    }
    this.child?.kill('SIGKILL');
    return canceling;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) {
      this.publish({ status: 'stopped', generation: this.generation });
      return;
    }
    const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
    await this.client?.shutdown().catch(() => undefined);
    const graceful = await Promise.race([exited.then(() => true), delay(10_000).then(() => false)]);
    if (!graceful) {
      child.kill('SIGKILL');
      await exited;
    }
    if (this.child === child) this.child = undefined;
    this.client = undefined;
    this.privateBootstrap = undefined;
    this.publish({ status: 'stopped', generation: this.generation });
  }
}
