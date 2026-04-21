import { createIngestionRuntime } from "../runtime/ingestion.js";
import { createProjectServices } from "../runtime/services.js";

export interface IngestOptions {
  projectPath?: string;
  full?: boolean;
  rebuildTool?: string;
}

export async function runIngest(options: IngestOptions = {}): Promise<void> {
  const services = await createProjectServices(options.projectPath);
  const runtime = await createIngestionRuntime(services);

  if (options.rebuildTool) {
    const result = await runtime.coordinator.rebuildTool(options.rebuildTool);
    console.log(
      `Rebuilt '${result.tool}': purged ${result.purged} stale chunk(s), ingested ${result.processedChunks} fresh chunk(s).`,
    );
    return;
  }

  const result = options.full
    ? await runtime.coordinator.fullSync()
    : await runtime.coordinator.runCycle();

  console.log(
    `Ingestion complete: ${result.processedChunks} chunks from ${result.processedScrapers} scraper(s).`,
  );
}
