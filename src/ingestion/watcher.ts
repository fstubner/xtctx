import chokidar, { type FSWatcher } from "chokidar";

export interface IngestionWatcherOptions {
  debounceMs?: number;
  ignored?: string[];
}

export class IngestionWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private callbackInFlight = false;
  private rerunQueued = false;

  constructor(
    private readonly watchPaths: string[],
    private readonly onChange: () => Promise<void> | void,
    private readonly options: IngestionWatcherOptions = {},
  ) {}

  async start(): Promise<void> {
    if (this.watcher) {
      return;
    }

    this.watcher = chokidar.watch(this.watchPaths, {
      ignoreInitial: true,
      ignored: this.options.ignored,
      awaitWriteFinish: {
        stabilityThreshold: 150,
        pollInterval: 50,
      },
    });

    const handler = () => this.schedule();
    this.watcher.on("add", handler);
    this.watcher.on("change", handler);
    this.watcher.on("unlink", handler);
  }

  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  private schedule(): void {
    const debounceMs = this.options.debounceMs ?? 300;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.invoke();
    }, debounceMs);
  }

  private async invoke(): Promise<void> {
    if (this.callbackInFlight) {
      this.rerunQueued = true;
      return;
    }

    this.callbackInFlight = true;
    try {
      await this.onChange();
    } finally {
      this.callbackInFlight = false;
      if (this.rerunQueued) {
        this.rerunQueued = false;
        void this.invoke();
      }
    }
  }
}
