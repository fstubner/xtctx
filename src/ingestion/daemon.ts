import { IngestionCoordinator } from "./coordinator.js";
import { IngestionWatcher, type IngestionWatcherOptions } from "./watcher.js";

export interface ExtraWatcherEntry {
  paths: string[];
  onChange: () => Promise<void>;
}

export interface IngestionDaemonOptions {
  pollIntervalMs: number;
  watchPaths: string[];
  watcher?: IngestionWatcherOptions;
  /** Additional path-specific watchers with their own callbacks. */
  extraWatchers?: ExtraWatcherEntry[];
}

export class IngestionDaemon {
  private watcher: IngestionWatcher | null = null;
  private extraWatcherInstances: IngestionWatcher[] = [];
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

    for (const entry of this.options.extraWatchers ?? []) {
      const w = new IngestionWatcher(entry.paths, entry.onChange, this.options.watcher);
      await w.start();
      this.extraWatcherInstances.push(w);
    }
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

    for (const w of this.extraWatcherInstances) {
      await w.stop();
    }
    this.extraWatcherInstances = [];
  }
}
