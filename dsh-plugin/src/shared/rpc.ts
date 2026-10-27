import type { RpcMessage } from './protocol.js';

/** Bidirectional, cancellable IPC; disposal rejects all owned requests. */
export class RpcPeer {
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; clean(): void }
  >();
  private running = new Map<number, AbortController>();
  constructor(
    private send: (message: RpcMessage) => void,
    private handle: (method: string, value: unknown, signal: AbortSignal) => Promise<unknown>,
    private report: (error: unknown) => void = () => {},
  ) {}
  call<T>(method: string, value: unknown, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        this.send({ type: 'cancel', id });
        this.pending.get(id)?.clean();
        this.pending.delete(id);
        reject(new Error('Operation canceled'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        clean: () => signal?.removeEventListener('abort', abort),
      });
      this.send({ type: 'call', id, method, value });
    });
  }
  receive(message: RpcMessage): void {
    if (message.type === 'reply') {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      request.clean();
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.value);
    } else if (message.type === 'cancel') this.running.get(message.id)?.abort();
    else if (message.type === 'call') {
      const controller = new AbortController();
      this.running.set(message.id, controller);
      void this.handle(message.method!, message.value, controller.signal)
        .then(
          (value) => this.send({ type: 'reply', id: message.id, value }),
          (error) => {
            this.report(error);
            this.send({
              type: 'reply',
              id: message.id,
              error: 'Host operation failed; inspect local diagnostics',
            });
          },
        )
        .finally(() => this.running.delete(message.id));
    }
  }
  close(): void {
    for (const request of this.pending.values()) {
      request.clean();
      request.reject(new Error('Runtime disconnected'));
    }
    this.pending.clear();
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
  }
}
