/**
 * Codex renamed the shape a human turn arrives in, and the reader kept looking
 * for the old one.
 *
 * Real turns used to be `event_msg` with `payload.type === "user_message"` and
 * the text on `payload.message`. Current Codex wraps them:
 * `payload.type === "item_completed"`, `payload.item.type === "UserMessage"`,
 * and the text inside a `content` parts array.
 *
 * Nothing caught the change. `event_msg` is a known event type and
 * `payload.type` was present, so the drift guard had nothing to report — the
 * turns simply stopped arriving. Measured across a real store of 825 session
 * files: 41 turns still in the old shape, 15,169 in the new one. A scrape of
 * that history returned the assistant side of every conversation and almost
 * none of what the person actually asked for, which is the half a handoff is
 * for.
 *
 * Verified against the newest real transcript on the machine that exposed it:
 * 32 human turns in the file, 0 emitted before, 32 after.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexCliScraper } from "@xtctx/scrapers/codex";
import type { CodexChunk } from "@xtctx/types/scraper";

describe("a human turn in a codex transcript", () => {
  let storeDir = "";
  let stateDir = "";
  const projectRoot = join("H:", "projects", "app");

  beforeEach(async () => {
    storeDir = await mkdtemp(join(tmpdir(), "xtctx-codex-user-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-codex-user-state-"));
  });

  afterEach(async () => {
    for (const dir of [storeDir, stateDir]) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function writeSession(records: unknown[]): Promise<void> {
    const dir = join(storeDir, "2026", "09", "07");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "rollout-user-turns.jsonl"),
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
      "utf-8",
    );
  }

  async function scrape(): Promise<CodexChunk[]> {
    const chunks: CodexChunk[] = [];
    for await (const chunk of new CodexCliScraper(storeDir, stateDir, projectRoot).fullSync()) {
      chunks.push(chunk);
    }
    return chunks;
  }

  const meta = {
    timestamp: "2026-09-07T10:00:00.000Z",
    type: "session_meta",
    payload: { id: "user-turns", cwd: projectRoot, originator: "codex_cli_rs" },
  };

  it("is read from the shape Codex writes now", async () => {
    // Copied from a real record, down to the parts array.
    await writeSession([
      meta,
      {
        timestamp: "2026-09-07T10:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: {
            type: "UserMessage",
            id: "01a07cd1",
            content: [{ type: "text", text: "Can you audit this project?\n", text_elements: [] }],
          },
        },
      },
    ]);

    const users = (await scrape()).filter((chunk) => chunk.role === "user");

    expect(users).toHaveLength(1);
    expect(users[0].content).toContain("Can you audit this project?");
  });

  it("is still read from the shape Codex used to write", async () => {
    // The old shape has not vanished — a real store carried both.
    await writeSession([
      meta,
      {
        timestamp: "2026-09-07T10:00:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "the older shape" },
      },
    ]);

    const users = (await scrape()).filter((chunk) => chunk.role === "user");

    expect(users).toHaveLength(1);
    expect(users[0].content).toBe("the older shape");
  });

  it("joins a turn split across several text parts", async () => {
    await writeSession([
      meta,
      {
        timestamp: "2026-09-07T10:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: {
            type: "UserMessage",
            content: [
              { type: "text", text: "first part" },
              { type: "text", text: "second part" },
            ],
          },
        },
      },
    ]);

    const [user] = (await scrape()).filter((chunk) => chunk.role === "user");

    expect(user.content).toContain("first part");
    expect(user.content).toContain("second part");
  });

  it("leaves the other item types to the readers that handle them", async () => {
    // `item_completed` also wraps the assistant side and tool activity. Only
    // UserMessage is a human turn; treating the rest as one would invent
    // turns nobody typed.
    await writeSession([
      meta,
      {
        timestamp: "2026-09-07T10:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: { type: "AgentMessage", content: [{ type: "text", text: "assistant text" }] },
        },
      },
      {
        timestamp: "2026-09-07T10:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: { type: "CommandExecution", content: [{ type: "text", text: "ls -la" }] },
        },
      },
    ]);

    expect((await scrape()).filter((chunk) => chunk.role === "user")).toHaveLength(0);
  });
});
