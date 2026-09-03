import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexCliScraper } from "@xtctx/scrapers/codex";
import type { CodexChunk } from "@xtctx/types/scraper";

/**
 * Codex CLI sessions are stored as JSONL event streams.
 *
 * Each line is a JSON event with `type` ∈ {session_meta, turn_context,
 * response_item, event_msg, compacted}. The scraper maps:
 *
 *  - event_msg (payload.type === "user_message")     → user chunk
 *  - response_item (payload.role === "assistant")    → assistant chunk
 *  - response_item (payload.role === "user")         → SKIPPED (system injections)
 *
 * Real sessions live in year/month/day subdirectories:
 *   ~/.codex/sessions/2025/12/21/rollout-<id>.jsonl
 * The scraper uses glob to discover them recursively.
 */

const SESSION_UUID = "test-codex-session-uuid";

function sessionMeta(id: string, timestamp: string, cwd = "/some/project") {
  return JSON.stringify({
    timestamp,
    type: "session_meta",
    payload: { id, timestamp, cwd, originator: "codex_cli_rs" },
  });
}

function turnContext(approvalPolicy: string, sandboxType: string) {
  return JSON.stringify({
    timestamp: "2026-02-24T09:59:01Z",
    type: "turn_context",
    payload: {
      approval_policy: approvalPolicy,
      sandbox_policy: { type: sandboxType },
      model: "gpt-4o-codex",
    },
  });
}

/** Real user-typed message (from event_msg). */
function userMessage(text: string, timestamp: string) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: { type: "user_message", message: text },
  });
}

/** AI assistant response (from response_item with role: "assistant"). */
function assistantMessage(text: string, timestamp: string) {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  });
}

/** System-injected context like AGENTS.md (response_item role: "user") - should be skipped. */
function systemInjectedContext(text: string, timestamp: string) {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  });
}

describe("CodexCliScraper", () => {
  let tempDir = "";
  let stateDir = "";
  let scraper: CodexCliScraper;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "xtctx-codex-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-state-"));
    await mkdir(tempDir, { recursive: true });

    // Write session file in the top-level dir (glob **/*.jsonl finds it)
    await writeFile(
      join(tempDir, "session-a.jsonl"),
      [
        sessionMeta(SESSION_UUID, "2026-02-24T09:59:00Z"),
        turnContext("suggest", "workspace-write"),
        // System injection (should be skipped)
        systemInjectedContext("# AGENTS.md content here...", "2026-02-24T09:59:50Z"),
        // Actual user message
        userMessage("codex first", "2026-02-24T10:00:00Z"),
        assistantMessage("codex second", "2026-02-24T10:00:05Z"),
      ].join("\n") + "\n",
      "utf-8",
    );

    scraper = new CodexCliScraper(tempDir, stateDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it("detects codex session path", async () => {
    expect(await scraper.detect()).toBe(true);
  });

  it("reads user event_msg and assistant response_item messages", async () => {
    const chunks: CodexChunk[] = [];
    for await (const chunk of scraper.fullSync()) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(2);

    expect(chunks[0].role).toBe("user");
    expect(chunks[0].content).toBe("codex first");
    expect(chunks[0].sessionId).toBe(SESSION_UUID);
    // approvalMode from turn_context approval_policy "suggest"
    expect(chunks[0].metadata.approvalMode).toBe("suggest");
    // sandbox_policy type "workspace-write" !== "none" → sandboxed = true
    expect(chunks[0].metadata.sandboxed).toBe(true);

    expect(chunks[1].role).toBe("assistant");
    expect(chunks[1].content).toBe("codex second");
  });

  it("keeps messageIndex stable when compacted events fall below the cutoff", async () => {
    await writeFile(
      join(tempDir, "session-compacted.jsonl"),
      [
        sessionMeta("compacted-session", "2026-02-24T09:59:00Z"),
        JSON.stringify({
          timestamp: "2026-02-24T10:00:00Z",
          type: "compacted",
          payload: { summary: "earlier turns summarized" },
        }),
        assistantMessage("after compaction", "2026-02-24T11:00:00Z"),
      ].join("\n") + "\n",
      "utf-8",
    );

    const full: CodexChunk[] = [];
    for await (const chunk of scraper.fullSync()) full.push(chunk);
    const incremental: CodexChunk[] = [];
    for await (const chunk of scraper.scrape(new Date("2026-02-24T10:30:00Z"))) {
      incremental.push(chunk);
    }

    const fullAfter = full.find((chunk) => chunk.content === "after compaction");
    const incrementalAfter = incremental.find((chunk) => chunk.content === "after compaction");
    expect(fullAfter?.metadata.messageIndex).toBe(1);
    expect(incrementalAfter?.metadata.messageIndex).toBe(1);
  });

  it("preserves approval mode and sandbox state across partial turn_context updates", async () => {
    await writeFile(
      join(tempDir, "session-context.jsonl"),
      [
        sessionMeta("context-session", "2026-02-24T09:59:00Z"),
        turnContext("auto-edit", "workspace-write"),
        // A later turn_context with an unknown policy and no sandbox_policy
        // must not clobber the known state.
        JSON.stringify({
          timestamp: "2026-02-24T09:59:30Z",
          type: "turn_context",
          payload: { approval_policy: "yolo-mode" },
        }),
        assistantMessage("still sandboxed", "2026-02-24T10:00:00Z"),
      ].join("\n") + "\n",
      "utf-8",
    );

    const chunks: CodexChunk[] = [];
    for await (const chunk of scraper.fullSync()) chunks.push(chunk);

    const target = chunks.find((chunk) => chunk.content === "still sandboxed");
    expect(target?.metadata.approvalMode).toBe("auto-edit");
    expect(target?.metadata.sandboxed).toBe(true);
  });

  it("skips system-injected response_item user messages", async () => {
    const chunks: CodexChunk[] = [];
    for await (const chunk of scraper.fullSync()) {
      chunks.push(chunk);
    }

    // AGENTS.md injection should not appear as a chunk
    const injected = chunks.find((c) => c.content.includes("AGENTS.md"));
    expect(injected).toBeUndefined();
  });

  it("supports recursive discovery of nested session files", async () => {
    // Mirror the real Codex year/month/day layout
    const nestedDir = join(tempDir, "2025", "12", "21");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(
      join(nestedDir, "session-nested.jsonl"),
      [
        sessionMeta("nested-session", "2026-01-01T00:00:00Z"),
        turnContext("full-auto", "none"),
        userMessage("nested question", "2026-01-01T00:00:01Z"),
      ].join("\n") + "\n",
      "utf-8",
    );

    const chunks: CodexChunk[] = [];
    for await (const chunk of scraper.fullSync()) {
      chunks.push(chunk);
    }

    // Should include chunks from both top-level and nested files
    expect(chunks.length).toBeGreaterThan(2);
    const nested = chunks.find((c) => c.content === "nested question");
    expect(nested).toBeDefined();
    expect(nested?.sessionId).toBe("nested-session");
    expect(nested?.metadata.approvalMode).toBe("full-auto");
    expect(nested?.metadata.sandboxed).toBe(false); // sandbox_policy.type === "none"
  });

  it("limits project-scoped scrapers to matching Codex session cwd values", async () => {
    await writeFile(
      join(tempDir, "session-other-project.jsonl"),
      [
        sessionMeta("other-session", "2026-02-25T00:00:00Z", "/other/project"),
        userMessage("other project", "2026-02-25T00:00:01Z"),
      ].join("\n") + "\n",
      "utf-8",
    );

    const scoped = new CodexCliScraper(tempDir, stateDir, "/some/project");
    const chunks: CodexChunk[] = [];
    for await (const chunk of scoped.fullSync()) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.content)).toContain("codex first");
    expect(chunks.map((chunk) => chunk.content)).not.toContain("other project");
  });

  it("filters incremental results by timestamp", async () => {
    const chunks: CodexChunk[] = [];
    for await (const chunk of scraper.scrape(new Date("2026-02-24T10:00:00Z"))) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe("codex second");
  });

  it("skips non-conversation event types", async () => {
    // Asserted on what must NOT appear, not only on what must.
    //
    // This test used to check only that the real message was present, and it
    // passed with the `payload.type === "user_message"` filter deleted
    // entirely — because its one `event_msg` extra carried no `message`
    // field, so it produced no content either way. A mutation sweep found
    // that: removing the filter left all 552 tests green.
    //
    // `agent_message` is the case that matters. It is a real Codex event type
    // and it does carry `message`, so without the filter every assistant turn
    // would also be served as something the user typed.
    const sessionWithExtras = join(tempDir, "session-extras.jsonl");
    await writeFile(
      sessionWithExtras,
      [
        sessionMeta("extra-session", "2026-02-25T00:00:00Z"),
        JSON.stringify({
          timestamp: "2026-02-25T00:00:01Z",
          type: "event_msg",
          payload: { type: "agent_message", message: "assistant thinking aloud" },
        }),
        JSON.stringify({
          timestamp: "2026-02-25T00:00:02Z",
          type: "event_msg",
          payload: { type: "tool_call_result", message: "tool output", result: "ignored" },
        }),
        // response_item with non-message payload should be ignored
        JSON.stringify({
          timestamp: "2026-02-25T00:00:03Z",
          type: "response_item",
          payload: { type: "function_call", name: "read_file" },
        }),
        userMessage("real message", "2026-02-25T00:00:04Z"),
      ].join("\n") + "\n",
      "utf-8",
    );

    const chunks: CodexChunk[] = [];
    for await (const chunk of scraper.fullSync()) {
      chunks.push(chunk);
    }

    expect(chunks.find((c) => c.content === "real message")).toBeDefined();
    for (const leaked of ["assistant thinking aloud", "tool output", "read_file"]) {
      expect(chunks.map((c) => c.content), leaked).not.toContain(leaked);
    }
  });

  it("assigns layer 0 to normal conversation turns", async () => {
    const chunks: CodexChunk[] = [];
    for await (const chunk of scraper.fullSync()) {
      chunks.push(chunk);
    }

    for (const chunk of chunks) {
      expect(chunk.metadata.layer).toBe(0);
    }
  });

  it("emits compacted events as layer-1 chunks", async () => {
    const compactedSession = join(tempDir, "session-compacted.jsonl");
    await writeFile(
      compactedSession,
      [
        sessionMeta("compact-session", "2026-02-26T08:00:00Z"),
        turnContext("suggest", "workspace-write"),
        // compacted event with summary payload
        JSON.stringify({
          timestamp: "2026-02-26T08:05:00Z",
          type: "compacted",
          payload: {
            summary: "The session discussed refactoring the auth module and adding tests.",
            turns_compacted: 8,
          },
        }),
        // Regular user message after compaction
        userMessage("continue from here", "2026-02-26T08:06:00Z"),
      ].join("\n") + "\n",
      "utf-8",
    );

    const chunks: CodexChunk[] = [];
    for await (const chunk of scraper.fullSync()) {
      chunks.push(chunk);
    }

    const compacted = chunks.find((c) => c.content.includes("auth module"));
    expect(compacted).toBeDefined();
    expect(compacted?.metadata.layer).toBe(1);
    expect(compacted?.role).toBe("assistant");
    expect(compacted?.sessionId).toBe("compact-session");

    // Regular message should still be layer 0
    const regular = chunks.find((c) => c.content === "continue from here");
    expect(regular).toBeDefined();
    expect(regular?.metadata.layer).toBe(0);
  });

  it("uses content field as fallback when compacted summary is absent", async () => {
    const fallbackSession = join(tempDir, "session-compact-fallback.jsonl");
    await writeFile(
      fallbackSession,
      [
        sessionMeta("fallback-session", "2026-02-27T09:00:00Z"),
        turnContext("full-auto", "none"),
        JSON.stringify({
          timestamp: "2026-02-27T09:05:00Z",
          type: "compacted",
          payload: {
            content: "Previous work involved database migration scripts.",
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const chunks: CodexChunk[] = [];
    for await (const chunk of scraper.fullSync()) {
      chunks.push(chunk);
    }

    const compacted = chunks.find((c) => c.content.includes("database migration"));
    expect(compacted).toBeDefined();
    expect(compacted?.metadata.layer).toBe(1);
  });
});
