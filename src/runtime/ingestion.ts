import { join } from "node:path";
import { IngestionCoordinator } from "../ingestion/coordinator.js";
import { IngestionDaemon } from "../ingestion/daemon.js";
import { ClaudeCodeScraper } from "../scrapers/claude-code.js";
import { ScraperRegistry } from "../scrapers/registry.js";
import { EmbeddingService } from "../store/embeddings.js";
import { LanceStore } from "../store/lance.js";
import { HybridSearch } from "../store/search.js";
import type { ProjectServices } from "./services.js";

export interface IngestionRuntime {
  store: LanceStore;
  embeddings: EmbeddingService;
  search: HybridSearch;
  registry: ScraperRegistry;
  coordinator: IngestionCoordinator;
  daemon: IngestionDaemon;
}

class LazyEmbeddingService extends EmbeddingService {
  private initPromise: Promise<void> | null = null;

  override async initialize(): Promise<void> {
    await this.ensureInitialized();
  }

  override async embed(text: string): Promise<number[]> {
    await this.ensureInitialized();
    return super.embed(text);
  }

  override async embedBatch(texts: string[]): Promise<number[][]> {
    await this.ensureInitialized();
    return super.embedBatch(texts);
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = super.initialize();
    }
    await this.initPromise;
  }
}

export async function createIngestionRuntime(
  services: ProjectServices,
): Promise<IngestionRuntime> {
  const store = new LanceStore(join(services.storeDir, "lancedb"));
  await store.initialize();

  const embeddings = new LazyEmbeddingService();
  const search = new HybridSearch(store, embeddings);
  const registry = new ScraperRegistry();

  const claudeConfig = services.ingestion.scrapers.find(
    (scraper) => scraper.tool === "claude-code",
  );
  const claudeEnabled = claudeConfig ? claudeConfig.enabled : true;

  if (claudeEnabled) {
    registry.register(
      new ClaudeCodeScraper(
        claudeConfig?.customStorePath ?? defaultClaudeProjectsDir(),
        services.stateDir,
      ),
    );
  }

  const watchPaths = uniquePaths([
    ...services.ingestion.watchPaths,
    ...registry.getAll().flatMap((scraper) => scraper.getStorePaths()),
  ]);

  const coordinator = new IngestionCoordinator({
    registry,
    embeddings,
    store,
  });

  const daemon = new IngestionDaemon(coordinator, {
    pollIntervalMs: services.ingestion.pollIntervalMs,
    watchPaths,
    watcher: {
      ignored: services.ingestion.excludePatterns,
      debounceMs: 350,
    },
  });

  return {
    store,
    embeddings,
    search,
    registry,
    coordinator,
    daemon,
  };
}

function defaultClaudeProjectsDir(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return join(home, ".claude", "projects");
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter((path) => path.length > 0))];
}
