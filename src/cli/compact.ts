import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { CompactionPipeline } from "../compaction/pipeline.js";
import { FileCompactionSink } from "../compaction/sink.js";
import type { CompactionConfig } from "../types/compaction.js";
import type { ConversationChunk } from "../types/scraper.js";
import { createProjectServices } from "../runtime/services.js";
import { createIngestionRuntime } from "../runtime/ingestion.js";

export interface CompactOptions {
  projectPath?: string;
  full?: boolean;
}

export async function runCompact(options: CompactOptions = {}): Promise<void> {
  const projectRoot = resolve(options.projectPath ?? process.cwd());
  const services = await createProjectServices(projectRoot);
  const runtime = await createIngestionRuntime(services);

  const compactionDir = join(services.storeDir, "compactions");
  const sink = new FileCompactionSink(compactionDir);
  const config = await loadCompactionConfig(services.xtctxDir);

  const source = {
    async listAllChunks(): Promise<ConversationChunk[]> {
      const results = await runtime.store.ftsSearch("conversations", "*", 10_000);
      return results.map((r) => {
        const meta = typeof r.metadata === "string"
          ? JSON.parse(r.metadata) as Record<string, unknown>
          : {};
        return {
          tool: (meta.tool as string) ?? "unknown",
          sessionId: (meta.sessionId as string) ?? r.id,
          role: (meta.role as ConversationChunk["role"]) ?? "assistant",
          content: r.text,
          timestamp: new Date((meta.timestamp as string) ?? 0),
          metadata: {
            messageIndex: Number(meta.messageIndex) || 0,
            tokenEstimate: typeof meta.tokenEstimate === "number" ? meta.tokenEstimate : undefined,
          },
        };
      });
    },
  };

  const pipeline = new CompactionPipeline(source, sink, config);

  console.log(`Running ${config.strategy} compaction for ${projectRoot}...`);

  const sessions = options.full
    ? await pipeline.runFull()
    : await pipeline.runIncremental(new Date(Date.now() - 24 * 60 * 60 * 1000));

  console.log(
    `Compaction complete: ${sessions.length} session(s) processed (strategy: ${config.strategy})`,
  );

  for (const session of sessions) {
    console.log(
      `  ${session.sessionId}: ${session.tool} | ${session.chunkCount} chunks | ${session.summary.slice(0, 80)}`,
    );
  }
}

async function loadCompactionConfig(xtctxDir: string): Promise<CompactionConfig> {
  try {
    const raw = await readFile(join(xtctxDir, "config.yaml"), "utf-8");
    const config = parseYaml(raw) as Record<string, unknown>;
    const compaction = config.compaction as Record<string, unknown> | undefined;

    if (!compaction) {
      return { strategy: "rule-based", sessionBoundaryMinutes: 30 };
    }

    const strategy = compaction.strategy === "llm-assisted" ? "llm-assisted" : "rule-based";
    const sessionBoundaryMinutes = Number(compaction.sessionBoundaryMinutes) || 30;

    const result: CompactionConfig = { strategy, sessionBoundaryMinutes };

    if (strategy === "llm-assisted" && compaction.llm && typeof compaction.llm === "object") {
      const llm = compaction.llm as Record<string, unknown>;
      result.llm = {
        provider: (llm.provider as "cli" | "ollama" | "openai") ?? "cli",
        command: typeof llm.command === "string" ? llm.command : undefined,
        args: Array.isArray(llm.args) ? llm.args.filter((a): a is string => typeof a === "string") : undefined,
        model: typeof llm.model === "string" ? llm.model : undefined,
        endpoint: typeof llm.endpoint === "string" ? llm.endpoint : undefined,
        apiKeyEnv: typeof llm.apiKeyEnv === "string" ? llm.apiKeyEnv : undefined,
      };
    }

    return result;
  } catch {
    return { strategy: "rule-based", sessionBoundaryMinutes: 30 };
  }
}
