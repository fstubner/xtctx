import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { CompactedSession } from "../types/compaction.js";
import type { CompactionSink } from "./pipeline.js";

/**
 * Persists compacted sessions as YAML files in .xtctx/.store/compactions/.
 * Each session gets its own file keyed by sessionId.
 *
 * **Status: future feature (M2)**
 *
 * The compaction pipeline runs correctly and writes YAML output here, but
 * nothing in the current search path reads these files.  They are produced for
 * future use as a compressed conversation layer that can be injected into
 * context windows instead of raw messages.
 *
 * TODO(M2): Surface compacted sessions in the hybrid-search path once the
 *           compaction-to-embedding pipeline is complete.  The `loadSession`
 *           method below is the intended read-side API.
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
