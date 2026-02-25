export interface IngestOptions {
  projectPath?: string;
  full?: boolean;
}

export async function runIngest(_options: IngestOptions = {}): Promise<void> {
  console.log("xtctx ingest is not implemented yet.");
  console.log("Planned in Phase 6: ingestion coordinator and daemon.");
}
