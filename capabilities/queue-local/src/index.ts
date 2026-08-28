import {
  DurableJobDispatcher,
  type DurableJobDispatcherOptions,
  type EnqueueJobInput,
  type JobDispatcherDiagnostics,
  type JobHandlerRegistry,
  type PlatformJob,
  type PlatformJobQueue,
  type PlatformJobState,
  type PlatformRepository,
} from '@zhiyun/platform-core';

export class LocalPlatformJobQueue implements PlatformJobQueue {
  private readonly dispatcher: DurableJobDispatcher;

  constructor(
    private readonly repository: PlatformRepository,
    handlers: JobHandlerRegistry,
    options: DurableJobDispatcherOptions = {},
  ) {
    this.dispatcher = new DurableJobDispatcher(repository, handlers, options);
  }

  enqueue(input: EnqueueJobInput): Promise<PlatformJob> {
    return this.repository.enqueueJob(input);
  }

  get(id: string): Promise<PlatformJob | null> {
    return this.repository.getJob(id);
  }

  list(options?: {
    ownerPluginId?: string;
    states?: readonly PlatformJobState[];
    limit?: number;
  }): Promise<PlatformJob[]> {
    return this.repository.listJobs(options);
  }

  cancel(id: string): Promise<PlatformJob | null> {
    return this.repository.requestJobCancel(id);
  }

  start(): void {
    this.dispatcher.start();
  }

  async dispatchOnce(): Promise<void> {
    await this.dispatcher.tick();
    await this.dispatcher.drain();
  }

  diagnostics(): JobDispatcherDiagnostics {
    return this.dispatcher.diagnostics();
  }

  close(): Promise<void> {
    return this.dispatcher.close();
  }
}
