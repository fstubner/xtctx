import { describe, it, expect } from "vitest";
import { compactChunksRuleBased } from "@xtctx/compaction/rule-based";
import type { ConversationChunk } from "@xtctx/types/scraper";

describe("compactChunksRuleBased", () => {
  it("builds a compacted session with extracted signals", () => {
    const chunks: ConversationChunk[] = [
      chunk("2026-02-25T10:00:00Z", "user", "Please set up vitest and update src/app.ts"),
      chunk("2026-02-25T10:00:20Z", "assistant", "Implemented tests and created tests/app.test.ts"),
      chunk("2026-02-25T10:00:40Z", "assistant", "Decision: use Vitest over Jest for ESM support."),
      chunk("2026-02-25T10:00:50Z", "user", "Should we add coverage thresholds?"),
    ];

    const sessions = compactChunksRuleBased(chunks, { sessionBoundaryMinutes: 30 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0].summary.toLowerCase()).toContain("vitest");
    expect(sessions[0].filesModified).toContain("src/app.ts");
    expect(sessions[0].filesModified).toContain("tests/app.test.ts");
    expect(sessions[0].tasksCompleted.length).toBeGreaterThan(0);
    expect(sessions[0].decisionsIdentified.length).toBeGreaterThan(0);
    expect(sessions[0].openQuestions.length).toBeGreaterThan(0);
    expect(sessions[0].chunkCount).toBe(4);
  });

  it("splits sessions when message gap exceeds boundary window", () => {
    const chunks: ConversationChunk[] = [
      chunk("2026-02-25T10:00:00Z", "user", "first block"),
      chunk("2026-02-25T10:00:10Z", "assistant", "done"),
      chunk("2026-02-25T11:00:00Z", "user", "second block after long gap"),
    ];

    const sessions = compactChunksRuleBased(chunks, { sessionBoundaryMinutes: 30 });
    expect(sessions).toHaveLength(2);
    expect(sessions[0].chunkCount).toBe(2);
    expect(sessions[1].chunkCount).toBe(1);
  });
});

function chunk(
  timestamp: string,
  role: ConversationChunk["role"],
  content: string,
): ConversationChunk {
  return {
    tool: "claude-code",
    sessionId: "sess-1",
    timestamp: new Date(timestamp),
    role,
    content,
    metadata: {
      messageIndex: 0,
      referencedFiles: [],
    },
  };
}
