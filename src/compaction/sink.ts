import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { CompactedSession } from "../types/compaction.js";
import type { CompactionSink } from "./pipeline.js";

/**
 * Persists compacted sessions as YAML files in .xtctx/.store/compactions/.
 * Each session gets its own file keyed by sessionId.
 *
 * **Status: shipped (M2).**
 *
 * YAMLs are persisted here as the durable artifact, and `xtctx compact` now
 * additionally upserts each compacted session into the hybrid-search index
 * via `CompactionIndexer` (metadata.layer = 1).  Raw message chunks remain
 * layer 0 and continue to rank on their own; compacted summaries surface in
 * recall for distilled "why/what/how" queries without any ranking override.
 * `loadSession` is kept as the point-read API for consumers that want the
 * full structured document behind a search hit.
 */
export class FileCompactionSink implements CompactionSink {
  constructor(private readonly compactionDir: string) {}

  async saveCompactedSessions(sessions: CompactedSession[]): Promise<void> {
    await mkdir(this.compactionDir, { recursive: true });

    for (const session of sessions) {
      const filePath = join(this.compactionDir, `${session.sessionId}.yaml`);
      const content = stringifyYaml(session);
      await writeFile(filePath, content, "utf-8");
    }
  }

  async loadSession(sessionId: string): Promise<CompactedSession | null> {
    const filePath = join(this.compactionDir, `${sessionId}.yaml`);
    try {
      const raw = await readFile(filePath, "utf-8");
      return parseYaml(raw) as CompactedSession;
    } catch {
      return null;
    }
  }
}
