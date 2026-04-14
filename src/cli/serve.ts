import { startApiServer } from "../api/server.js";
import { syncToolHooks } from "../config/hooks.js";
import { loadEffectiveContinuityPolicy } from "../config/policy.js";
import { syncToolConfigs } from "../config/sync.js";
import { getToolContinuityStatuses } from "../config/sync.js";
import { KnowledgeRepository } from "../knowledge/repository.js";
import { ProjectAutoTagger } from "../knowledge/tagger.js";
import type { KnowledgeWriter } from "../mcp/tools/write.js";
import { startMcpServer, type McpToolDependencies } from "../mcp/server.js";
import { createIngestionRuntime, type IngestionRuntime } from "../runtime/ingestion.js";
import { createProjectServices } from "../runtime/services.js";
import type { ContextRecord } from "../types/context.js";
import { errorMessage } from "../utils/errors.js";
import { withRetry } from "../utils/retry.js";
import {
  closeHttpServer,
  ShutdownCoordinator,
  type ShutdownError,
} from "../utils/shutdown.js";

interface ServeOptions {
  projectPath?: string;
  mcpOnly?: boolean;
}

/**
 * Wraps KnowledgeWriter to also index each saved record into LanceDB so that
 * findSimilar can use ANN vector search instead of brute-force in-memory cosine.
 */
class VectorIndexedKnowledgeWriter implements KnowledgeWriter {
  constructor(
    private readonly inner: KnowledgeWriter,
    private readonly runtime: IngestionRuntime,
  ) {}

  async save(record: ContextRecord): Promise<void> {
    await this.inner.save(record);
    const text = `${record.title}\n${record.body}`;
    const vector = await this.runtime.embeddings.embed(text);
    await this.runtime.store.upsert("knowledge", [{
      id: record.id,
      text,
      vector,
      source_type: record.type,
      metadata: JSON.stringify({ type: record.type, source_tool: record.source_tool }),
    }]);
  }

  async supersede(oldId: string, newId: string): Promise<void> {
    return this.inner.supersede?.(oldId, newId);
  }
}

/**
 * On first startup (no "knowledge" table in LanceDB yet), embed and index all
 * existing YAML knowledge records so the vector store is consistent.
 * Subsequent startups skip this — VectorIndexedKnowledgeWriter keeps it in sync.
 */
async function indexExistingKnowledge(
  knowledge: KnowledgeRepository,
  runtime: IngestionRuntime,
): Promise<void> {
  if (await runtime.store.tableExists("knowledge")) {
    return;
  }
  const records = await knowledge.listAll();
  if (records.length === 0) {
    return;
  }
  const texts = records.map((r) => `${r.title}\n${r.body}`);
  const vectors = await runtime.embeddings.embedBatch(texts);
  await runtime.store.upsert("knowledge", records.map((r, i) => ({
    id: r.id,
    text: texts[i]!,
    vector: vectors[i] ?? [],
    source_type: r.type,
    metadata: JSON.stringify({ type: r.type, source_tool: r.source_tool }),
  })));
}

export async function runServe(options: ServeOptions = {}): Promise<void> {
  const services = await createProjectServices(options.projectPath);
  await runAutoSync(services.projectRoot, "startup");
  const runtime = await createIngestionRuntime(services);
  await indexExistingKnowledge(services.knowledge, runtime);

  const writer = new VectorIndexedKnowledgeWriter(services.knowledge, runtime);

  let apiHandle: Awaited<ReturnType<typeof startApiServer>> | null = null;
  let syncInterval: NodeJS.Timeout | null = null;
  const shutdown = new ShutdownCoordinator();

  shutdown.register("api-server", async () => {
    if (apiHandle) {
      await closeHttpServer(apiHandle.server);
      apiHandle = null;
    }
  });
  shutdown.register("ingestion-daemon", async () => {
    await runtime.daemon.stop();
  });
  shutdown.register("continuity-sync", async () => {
    if (syncInterval) {
      clearInterval(syncInterval);
      syncInterval = null;
    }
  });

  shutdown.installSignalHandlers((signal) => {
    console.error(`xtctx serve: received ${signal}, shutting down.`);
    void shutdown.run(`signal:${signal}`).then((result) => {
      reportShutdownErrors(result.errors);
    }).finally(() => {
      process.exit(0);
    });
  });

  const autoTagger = new ProjectAutoTagger(services.projectRoot, services.domainTags);

  const dependencies: McpToolDependencies = {
    search: runtime.search,
    knowledge: services.knowledge,
    writer,
    autoTagger,
    sessions: services.sessions,
    configs: services.configs,
    continuity: {
      effectivePolicy: async () => loadEffectiveContinuityPolicy(services.projectRoot),
      toolStatuses: async () => getToolContinuityStatuses(services.projectRoot),
    },
    findSimilar: async (type, candidateText) => {
      const vector = await runtime.embeddings.embed(candidateText);
      const results = await runtime.store.vectorSearch(
        "knowledge",
        vector,
        1,
        { where: `source_type = '${type}'`, metric: "cosine" },
      );
      if (results.length === 0) return null;
      const top = results[0]!;
      return { id: top.id, similarity: top.score };
    },
  };

  try {
    if (!options.mcpOnly) {
      syncInterval = setInterval(() => {
        void runAutoSync(services.projectRoot, "reconcile");
      }, Math.max(15_000, services.ingestion.pollIntervalMs));

      await withRetry(
        async () => {
          await runtime.daemon.start();
        },
        {
          attempts: 3,
          minDelayMs: 250,
          maxDelayMs: 2_000,
          onRetry: (error, attempt, delayMs) => {
            console.error(
              `xtctx serve: ingestion startup failed (attempt ${attempt}). Retrying in ${delayMs}ms: ${errorMessage(error)}`,
            );
          },
        },
      );

      apiHandle = await withRetry(
        async () =>
          startApiServer({
            projectPath: services.projectRoot,
            port: services.webPort,
            // Pass the ingestion runtime's search so the Web UI and MCP tools
            // both use the same LanceDB hybrid-search pipeline (fixes C1).
            searchRunner: runtime.search,
            onScraperConfigChanged: (tool, enabled) => {
              if (enabled) {
                // Re-register the scraper when re-enabled via the Web UI
                // (fixes M5 — previously only the disabled branch was handled).
                const config = services.ingestion.scrapers.find((s) => s.tool === tool);
                runtime.reregisterBuiltinScraper(tool, config?.customStorePath);
              } else {
                runtime.registry.deregister(tool);
              }
            },
          }),
        {
          attempts: 3,
          minDelayMs: 250,
          maxDelayMs: 2_000,
          onRetry: (error, attempt, delayMs) => {
            console.error(
              `xtctx serve: API startup failed (attempt ${attempt}). Retrying in ${delayMs}ms: ${errorMessage(error)}`,
            );
          },
        },
      );
      await waitForApiReadiness(apiHandle.port);
      console.error(`xtctx serve: API server active on http://127.0.0.1:${apiHandle.port}`);
      console.error(`xtctx serve: web UI available at http://127.0.0.1:${apiHandle.port}/`);
      console.error(
        `xtctx serve: ingestion daemon active (poll ${services.ingestion.pollIntervalMs}ms).`,
      );
    }

    console.error(`xtctx serve: MCP stdio server active for project ${services.projectRoot}`);
    await startMcpServer(dependencies);
  } finally {
    shutdown.removeSignalHandlers();
    const result = await shutdown.run("serve-exit");
    reportShutdownErrors(result.errors);
  }
}

async function waitForApiReadiness(port: number): Promise<void> {
  await withRetry(
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (!response.ok) {
        throw new Error(`health endpoint returned ${response.status}`);
      }

      const payload = (await response.json()) as { ok?: boolean };
      if (!payload.ok) {
        throw new Error("health endpoint did not report ok=true");
      }
    },
    {
      attempts: 5,
      minDelayMs: 100,
      maxDelayMs: 1_000,
    },
  );
}

function reportShutdownErrors(errors: ShutdownError[]): void {
  for (const error of errors) {
    console.error(
      `xtctx serve: shutdown step '${error.name}' failed: ${errorMessage(error.error)}`,
    );
  }
}

async function runAutoSync(projectRoot: string, reason: "startup" | "reconcile"): Promise<void> {
  try {
    const result = await syncToolConfigs(projectRoot);
    const updates = result.updated + result.created;
    if (updates > 0 || result.warnings.length > 0 || reason === "startup") {
      console.error(
        `xtctx serve: continuity ${reason} sync complete (updated: ${result.updated}, created: ${result.created}, unchanged: ${result.unchanged}).`,
      );
    }

    for (const warning of result.warnings) {
      console.error(`xtctx serve: continuity warning: ${warning}`);
    }

    if (reason === "startup") {
      const hookResults = await syncToolHooks(projectRoot);
      for (const hook of hookResults) {
        if (hook.created) {
          console.error(`xtctx serve: created hook ${hook.tool}: ${hook.path}`);
        }
        if (hook.warning) {
          console.error(`xtctx serve: hook warning (${hook.tool}): ${hook.warning}`);
        }
      }
    }
  } catch (error) {
    console.error(`xtctx serve: continuity ${reason} sync failed: ${errorMessage(error)}`);
  }
}
