import type { AnalyticsWorkerClient } from '@zhiyun/analytics-worker-client';
import type { AnalyticsWorkerControl } from '@zhiyun/plugin-analytics';
import type { CorpusWorkerControl } from '@zhiyun/plugin-corpus';
import type { SnapshotWorkerClient } from '@zhiyun/plugin-datasets';

export class MutableAnalyticsWorker
  implements AnalyticsWorkerControl, CorpusWorkerControl, SnapshotWorkerClient
{
  constructor(private current: AnalyticsWorkerClient | undefined) {}

  available(): boolean {
    return Boolean(this.current);
  }

  set(worker: AnalyticsWorkerClient | undefined): void {
    this.current = worker;
  }

  private require(): AnalyticsWorkerClient {
    if (!this.current) throw new Error('ANALYTICS_UNAVAILABLE: Analytics Worker is unavailable');
    return this.current;
  }

  methods() {
    return this.require().methods();
  }

  version() {
    return this.require().version();
  }

  submit(input: Parameters<AnalyticsWorkerClient['submit']>[0]) {
    return this.require().submit(input);
  }

  job(jobId: string) {
    return this.require().job(jobId);
  }

  cancel(jobId: string) {
    return this.require().cancel(jobId);
  }
}
