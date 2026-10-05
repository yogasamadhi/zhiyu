import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

/** Native collection Chromium RSS only; Electron Renderer and Runtime are excluded. */
export class CollectionBrowserMemory {
  private root: number;
  private stopped = false;
  private samples = 0;
  private browserSamples = 0;
  private peakBytes = 0;
  private peakProcesses = 0;
  private error: unknown;
  private readonly loop: Promise<void>;

  constructor(ownedElectronPid: number) {
    this.root = ownedElectronPid;
    this.loop = this.sample().catch((error: unknown) => {
      this.error = error;
    });
  }

  setRoot(ownedElectronPid: number): void {
    this.root = ownedElectronPid;
  }

  private async sample(): Promise<void> {
    while (!this.stopped) {
      // Only metadata from the process table; executable names are read solely
      // for descendants of the Electron process launched by this test.
      const { stdout } = await runFile('ps', ['-axo', 'pid=,ppid=,rss=']);
      const rows = stdout
        .trim()
        .split('\n')
        .map((line) => {
          const [pid, parent, rss] = line.trim().split(/\s+/).map(Number);
          return { pid: pid!, parent: parent!, bytes: rss! * 1024 };
        });
      const owned = new Set([this.root]);
      for (;;) {
        const next = rows.filter((row) => owned.has(row.parent) && !owned.has(row.pid));
        if (!next.length) break;
        for (const row of next) owned.add(row.pid);
      }
      const children = [...owned].filter((pid) => pid !== this.root);
      let browserBytes = 0;
      let browserProcesses = 0;
      if (children.length) {
        const { stdout: names } = await runFile('ps', [
          '-p',
          children.join(','),
          '-o',
          'pid=,comm=',
        ]).catch(() => ({ stdout: '' }));
        for (const line of names.trim().split('\n')) {
          const match = /^\s*(\d+)\s+(.+)$/.exec(line);
          if (!match || !/chrom(?:e|ium)/i.test(match[2]!)) continue;
          const row = rows.find((item) => item.pid === Number(match[1]));
          if (row) {
            browserBytes += row.bytes;
            browserProcesses++;
          }
        }
      }
      this.samples++;
      if (browserProcesses) this.browserSamples++;
      this.peakBytes = Math.max(this.peakBytes, browserBytes);
      this.peakProcesses = Math.max(this.peakProcesses, browserProcesses);
      await new Promise<void>((done) => setTimeout(done, 100));
    }
  }

  async stop() {
    this.stopped = true;
    await this.loop;
    if (this.error) throw this.error;
    if (!this.browserSamples) throw new Error('No owned collection Chromium RSS samples');
    return {
      scope: 'Collection Chromium root and helpers only; Electron/Runtime/Python excluded',
      sampling:
        'Sum of owned Chromium process ps RSS at 100ms plus ps latency, sampled lower bound; includes browser startup, DOM and replay, no forced GC',
      samples: this.samples,
      browserSamples: this.browserSamples,
      peakAggregateRssBytes: this.peakBytes,
      maximumSimultaneousBrowserProcesses: this.peakProcesses,
      httpComparison: 'Separate observation; not the HTTP Runtime RSS/throughput gate',
    };
  }
}
