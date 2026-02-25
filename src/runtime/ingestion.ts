import { join } from "node:path";
import { IngestionCoordinator } from "../ingestion/coordinator.js";
import { IngestionDaemon } from "../ingestion/daemon.js";
import { ClaudeCodeScraper } from "../scrapers/claude-code.js";
import { CodexCliScraper } from "../scrapers/codex.js";
import { CopilotScraper } from "../scrapers/copilot.js";
import { CursorScraper } from "../scrapers/cursor.js";
import { GeminiCliScraper } from "../scrapers/gemini.js";
import { ScraperRegistry } from "../scrapers/registry.js";
import { EmbeddingService } from "../store/embeddings.js";
import { LanceStore } from "../store/lance.js";
import { HybridSearch } from "../store/search.js";
import type { ConversationScraper } from "../types/scraper.js";
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
  const scraperConfigByTool = new Map(
    services.ingestion.scrapers.map((scraper) => [scraper.tool, scraper]),
  );

  registerConfiguredScraper(
    registry,
    scraperConfigByTool,
    "claude-code",
    defaultClaudeProjectsDir(),
    (storePath) => new ClaudeCodeScraper(storePath, services.stateDir),
  );
  registerConfiguredScraper(
    registry,
    scraperConfigByTool,
    "cursor",
    defaultCursorStorePath(),
    (storePath) => new CursorScraper(storePath, services.stateDir),
  );
  registerConfiguredScraper(
    registry,
    scraperConfigByTool,
    "codex",
    defaultCodexSessionsPath(),
    (storePath) => new CodexCliScraper(storePath, services.stateDir),
  );
  registerConfiguredScraper(
    registry,
    scraperConfigByTool,
    "copilot",
    defaultCopilotHistoryPath(),
    (storePath) => new CopilotScraper(storePath, services.stateDir),
  );
  registerConfiguredScraper(
    registry,
    scraperConfigByTool,
    "gemini",
    defaultGeminiHistoryPath(),
    (storePath) => new GeminiCliScraper(storePath, services.stateDir),
  );

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

function defaultCursorStorePath(): string {
  const appData = process.env.APPDATA;
  if (appData) {
    return join(appData, "Cursor", "User", "workspaceStorage");
  }

  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return join(home, ".cursor", "workspaceStorage");
}

function defaultCodexSessionsPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return join(home, ".codex", "sessions");
}

function defaultCopilotHistoryPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return join(home, ".copilot", "history");
}

function defaultGeminiHistoryPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return join(home, ".gemini", "history");
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter((path) => path.length > 0))];
}

function registerConfiguredScraper(
  registry: ScraperRegistry,
  configByTool: Map<string, { tool: string; enabled: boolean; customStorePath?: string }>,
  tool: string,
  defaultStorePath: string,
  factory: (storePath: string) => ConversationScraper,
): void {
  const config = configByTool.get(tool);
  const enabled = config ? config.enabled : true;

  if (!enabled) {
    return;
  }

  registry.register(factory(config?.customStorePath ?? defaultStorePath));
}
