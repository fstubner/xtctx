import { IngestionCoordinator } from "./coordinator.js";
import { IngestionWatcher, type IngestionWatcherOptions } from "./watcher.js";

export interface IngestionDaemonOptions {
  pollIntervalMs: number;
  watchPaths: string[];
  watcher?: IngestionWatcherOptions;
}

export class IngestionDaemon {
  private watcher: IngestionWatcher | null = null;
  private started = false;

  constructor(
    private readonly coordinator: IngestionCoordinator,
    private readonly options: IngestionDaemonOptions,
  ) {}

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    await this.coordinator.runCycle();
    this.coordinator.start(this.options.pollIntervalMs);

    this.watcher = new IngestionWatcher(
      this.options.watchPaths,
      async () => {
        await this.coordinator.runCycle();
      },
      this.options.watcher,
    );

    await this.watcher.start();
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;

    this.coordinator.stop();
    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }
  }
}
