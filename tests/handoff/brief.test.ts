/**
 * Tests for the handoff brief generator.
 *
 * Pure-function tests — no fs, no LanceDB, no scrapers. Tests fix
 * `now()` for deterministic age-formatting output.
 */
import { describe, expect, it } from "vitest";
import {
  generateHandoffBrief,
  pickHandoffSession,
  type HandoffSession,
} from "@xtctx/handoff/brief";

const FIXED_NOW = new Date("2026-05-05T12:00:00Z");
const now = () => FIXED_NOW;

function session(partial: Partial<HandoffSession>): HandoffSession {
  return {
    tool: "cursor",
    sessionRef: "ref-1",
    lastActivityAt: "2026-05-05T11:55:00Z",
    summary: "Discussing auth library choice.",
    sourcePath: "~/.cursor/.../state.vscdb",
    messageCount: 12,
    ...partial,
  };
}

describe("pickHandoffSession", () => {
  it("returns null when there are no sessions", () => {
    expect(pickHandoffSession([], "claude-code", { now })).toBeNull();
  });

  it("skips sessions in the current tool", () => {
    const sessions = [
      session({ tool: "claude-code", sessionRef: "skip-me" }),
    ];
    expect(pickHandoffSession(sessions, "claude-code", { now })).toBeNull();
  });

  it("returns the most-recent session not in the current tool", () => {
    const sessions = [
      session({
        tool: "claude-code",
        sessionRef: "claude-old",
        lastActivityAt: "2026-05-05T09:00:00Z",
      }),
      session({
        tool: "cursor",
        sessionRef: "cursor-recent",
        lastActivityAt: "2026-05-05T11:30:00Z",
      }),
      session({
        tool: "codex",
        sessionRef: "codex-stale",
        lastActivityAt: "2026-05-05T08:00:00Z",
      }),
    ];
    const picked = pickHandoffSession(sessions, "claude-code", { now });
    expect(picked?.sessionRef).toBe("cursor-recent");
  });

  it("ignores stale sessions older than the threshold", () => {
    // 8 days old (default threshold is 7 days)
    const stale = session({
      tool: "cursor",
      lastActivityAt: "2026-04-27T10:00:00Z",
    });
    expect(pickHandoffSession([stale], "claude-code", { now })).toBeNull();
  });

  it("respects a custom staleness threshold", () => {
    // 2 hours old. Default threshold (7d) accepts; 1h threshold rejects.
    const recent = session({
      tool: "cursor",
      lastActivityAt: "2026-05-05T10:00:00Z",
    });
    expect(
      pickHandoffSession([recent], "claude-code", { now }),
    ).not.toBeNull();
    expect(
      pickHandoffSession([recent], "claude-code", {
        now,
        staleThresholdMs: 60 * 60 * 1000, // 1 hour
      }),
    ).toBeNull();
  });

  it("does not assume the upstream session list is sorted", () => {
    // Out-of-order input — make sure we still pick the latest by timestamp,
    // not by array position. Defensive sort prevents a future change to
    // the indexer's ordering from silently breaking the brief.
    const sessions = [
      session({
        sessionRef: "old",
        lastActivityAt: "2026-05-04T12:00:00Z",
      }),
      session({
        sessionRef: "new",
        lastActivityAt: "2026-05-05T11:00:00Z",
      }),
      session({
        sessionRef: "middle",
        lastActivityAt: "2026-05-05T08:00:00Z",
      }),
    ];
    const picked = pickHandoffSession(sessions, "claude-code", { now });
    expect(picked?.sessionRef).toBe("new");
  });
});

describe("generateHandoffBrief", () => {
  it("returns empty string when no qualifying session exists", () => {
    // Empty string lets the caller cleanly skip the section in the
    // managed block instead of rendering a bare header.
    expect(generateHandoffBrief([], "claude-code", { now })).toBe("");
  });

  it("renders a markdown brief for a qualifying session", () => {
    const sessions = [
      session({
        tool: "cursor",
        sessionRef: "abc123",
        lastActivityAt: "2026-05-05T11:55:00Z", // 5 minutes before now
        summary: "Decided on jose over jsonwebtoken because of ESM support.",
        sourcePath: "~/.cursor/workspaceStorage/foo/state.vscdb",
        messageCount: 14,
      }),
    ];
    const brief = generateHandoffBrief(sessions, "claude-code", { now });

    expect(brief).toContain("## Last session in another tool");
    expect(brief).toContain("**Tool:** Cursor");
    expect(brief).toContain("5 minutes ago");
    expect(brief).toContain("**Messages:** 14");
    expect(brief).toContain("`abc123`");
    expect(brief).toContain("Decided on jose over jsonwebtoken");
    expect(brief).toContain(
      "Full transcript: `~/.cursor/workspaceStorage/foo/state.vscdb`",
    );
  });

  it("formats age correctly across thresholds", () => {
    const cases: Array<{ at: string; expect: string }> = [
      // "just now" for sub-minute (uses 30 seconds before fixed now)
      { at: "2026-05-05T11:59:30Z", expect: "just now" },
      { at: "2026-05-05T11:58:00Z", expect: "2 minutes ago" },
      { at: "2026-05-05T11:00:00Z", expect: "1 hour ago" },
      { at: "2026-05-05T08:00:00Z", expect: "4 hours ago" },
      { at: "2026-05-04T11:00:00Z", expect: "1 day ago" },
      { at: "2026-05-02T12:00:00Z", expect: "3 days ago" },
    ];
    for (const { at, expect: expected } of cases) {
      const brief = generateHandoffBrief(
        [session({ tool: "cursor", lastActivityAt: at })],
        "claude-code",
        { now },
      );
      expect(brief, `for timestamp ${at}`).toContain(expected);
    }
  });

  it("omits the message-count line when none was supplied", () => {
    const brief = generateHandoffBrief(
      [
        {
          tool: "cursor",
          sessionRef: "ref",
          lastActivityAt: "2026-05-05T11:30:00Z",
        },
      ],
      "claude-code",
      { now },
    );
    expect(brief).not.toContain("**Messages:**");
    expect(brief).toContain("**Session:** `ref`");
  });

  it("omits the summary block when none was supplied", () => {
    const brief = generateHandoffBrief(
      [
        {
          tool: "cursor",
          sessionRef: "ref",
          lastActivityAt: "2026-05-05T11:30:00Z",
        },
      ],
      "claude-code",
      { now },
    );
    // Brief is heading + tool/when + session-ref (3 non-empty lines).
    // No summary line, no transcript-pointer line.
    expect(brief.split("\n").filter((l) => l.length > 0)).toHaveLength(3);
    expect(brief).not.toMatch(/^[A-Z][a-z]+ed\b/m); // no summary sentence
    expect(brief).not.toContain("Full transcript");
  });

  it("omits the transcript pointer when no sourcePath was supplied", () => {
    const brief = generateHandoffBrief(
      [
        session({
          tool: "cursor",
          sessionRef: "ref",
          lastActivityAt: "2026-05-05T11:30:00Z",
          sourcePath: undefined,
        }),
      ],
      "claude-code",
      { now },
    );
    expect(brief).not.toContain("Full transcript");
  });

  it("formats unknown tool slugs as-is rather than guessing display names", () => {
    const brief = generateHandoffBrief(
      [
        session({
          tool: "future-tool-x",
          lastActivityAt: "2026-05-05T11:55:00Z",
        }),
      ],
      "claude-code",
      { now },
    );
    expect(brief).toContain("**Tool:** future-tool-x");
  });
});
