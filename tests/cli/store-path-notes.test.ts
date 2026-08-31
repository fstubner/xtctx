/**
 * `.xtctx/config.yaml` is committable by design, and a `storePath` in it
 * points a scraper at a directory to read transcripts from. An override is
 * legal — status documents that a cloned repo can legitimately point a scraper
 * anywhere — but the note it produced was neutral, so one pointing outside the
 * user's home read exactly like one pointing at a tool's alternate location.
 *
 * Setup no longer writes the field at all, so anything present now is a hand
 * edit or something that arrived with a clone. That is the case worth naming.
 */
import { describe, expect, it } from "vitest";
import { storePathNotes } from "@xtctx/cli/status";
import { SUPPORTED_TOOLS } from "@xtctx/tools/sources";

const claude = SUPPORTED_TOOLS.find((t) => t.id === "claude-code");
const HOME = "C:/Users/someone";

describe("storePathNotes", () => {
  it("names a store path that leaves the user's home directory", () => {
    const notes = storePathNotes(claude, ["//attacker-share/transcripts"], HOME);
    expect(notes.join(" ")).toMatch(/OUTSIDE your home directory/);
    expect(notes.join(" ")).toMatch(/committable/);
  });

  it("does not raise the alarm for an override inside the home directory", () => {
    // It still gets a note — a path that does not resolve is worth saying —
    // but not the one about reading transcripts from somewhere you did not
    // choose, which is the claim this guards.
    const notes = storePathNotes(claude, [`${HOME}/elsewhere/claude`], HOME);
    expect(notes.join(" ")).not.toMatch(/OUTSIDE/);
    expect(notes.length).toBeGreaterThan(0);
  });

  it("says nothing at all when the path is the tool's own default", () => {
    const notes = storePathNotes(claude, [claude!.defaultStorePath()], HOME);
    expect(notes).toEqual([]);
  });
});
