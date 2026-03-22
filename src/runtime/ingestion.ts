import { stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

/** Minimum shape required for a value to be treated as a scraper. */
function isValidScraper(value: unknown): value is ConversationScraper {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as ConversationScraper).tool === "string" &&
    typeof (value as ConversationScraper).detect === "function" &&
    typeof (value as ConversationScraper).scrape === "function" &&
    typeof (value as ConversationScraper).fullSync === "function" &&
    typeof (value as ConversationScraper).getLastScrapedPosition === "function" &&
    typeof (value as ConversationScraper).saveScrapedPosition === "function"
  );
}

/**
 * Loads community/custom scrapers from `.xtctx/scrapers.mjs` if present.
 *
 * The file should export a default array of `ConversationScraper` instances:
 *
 * ```js
 * // .xtctx/scrapers.mjs
 * import { ZedScraper } from "xtctx-scraper-zed";
 * export default [new ZedScraper()];
 * ```
 *
 * Invalid entries are silently skipped. Load errors are logged as warnings.
 */
async function loadExternalScrapers(projectRoot: string): Promise<ConversationScraper[]> {
  const scraperFile = join(projectRoot, ".xtctx", "scrapers.mjs");

  try {
    await stat(scraperFile);
  } catch {
    return [];
  }

  try {
    // Append a timestamp to bust Node.js ESM module cache on hot-reload.
    const fileUrl = pathToFileURL(scraperFile);
    fileUrl.search = `t=${Date.now()}`;
    const module = await import(fileUrl.href) as { default?: unknown };
    const exported = module.default;
    if (!Array.isArray(exported)) {
      console.warn(`[xtctx] ${scraperFile}: default export must be an array of scrapers`);
      return [];
    }
    return exported.filter(isValidScraper);
  } catch (err) {
    console.warn(`[xtctx] Failed to load external scrapers from ${scraperFile}:`, err);
    return [];
  }
}

export interface IngestionRuntime {
  store: LanceStore;
  embeddings: EmbeddingService;
  search: HybridSearch;
  registry: ScraperRegistry;
  coordinator: IngestionCoordinator;
  daemon: IngestionDaemon;
  /** Re-imports .xtctx/scrapers.mjs and swaps external scrapers in the registry. */
  reloadExternalScrapers: () => Promise<void>;
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

  // Load any community or project-local scrapers from .xtctx/scrapers.mjs.
  // Track tool names so we can cleanly deregister them on hot-reload.
  const externalScraperTools = new Set<string>();
  const externalScrapers = await loadExternalScrapers(services.projectRoot);
  for (const scraper of externalScrapers) {
    registry.register(scraper);
    externalScraperTools.add(scraper.tool);
  }

  const reloadExternalScrapers = async (): Promise<void> => {
    for (const tool of externalScraperTools) {
      registry.deregister(tool);
    }
    externalScraperTools.clear();

    const reloaded = await loadExternalScrapers(services.projectRoot);
    for (const scraper of reloaded) {
      registry.register(scraper);
      externalScraperTools.add(scraper.tool);
    }
    const names = [...externalScraperTools].join(", ") || "none";
    console.error(`[xtctx] External scrapers reloaded: ${names}`);
  };

  const watchPaths = uniquePaths([
    ...services.ingestion.watchPaths,
    ...registry.getAll().flatMap((scraper) => scraper.getStorePaths()),
  ]);

  const scrapersFilePath = join(services.projectRoot, ".xtctx", "scrapers.mjs");

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
    extraWatchers: [
      { paths: [scrapersFilePath], onChange: reloadExternalScrapers },
    ],
  });

  return {
    store,
    embeddings,
    search,
    registry,
    coordinator,
    daemon,
    reloadExternalScrapers,
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
  // VS Code stores Copilot Chat history in workspaceStorage SQLite files.
  const appData = process.env.APPDATA;
  if (appData) {
    return join(appData, "Code", "User", "workspaceStorage");
  }

  // macOS / Linux fallback
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return join(home, "Library", "Application Support", "Code", "User", "workspaceStorage");
}

function defaultGeminiHistoryPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  // Gemini CLI stores session files under ~/.gemini/tmp/<project>/chats/session-*.json
  return join(home, ".gemini", "tmp");
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
