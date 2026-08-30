import { describe, expect, it } from "vitest";
import {
  MARKERS,
  countManagedBlocks,
  removeManagedBlocks,
  stripMarkers,
} from "@xtctx/config/managed-block";

const { begin, end } = MARKERS;

describe("removeManagedBlocks", () => {
  it("returns content unchanged when there is no managed block", () => {
    const content = "line1\n\n\n\nline2\n";
    expect(removeManagedBlocks(content)).toBe(content);
  });

  it("preserves blank-line runs in user content outside the block", () => {
    // The bug this pins: a global \n{3,} collapse flattened blank lines
    // inside the user's own code fences, which the block promises to keep.
    const content = [
      "```txt",
      "line1",
      "",
      "",
      "",
      "line2",
      "```",
      "",
      begin,
      "generated",
      end,
      "",
    ].join("\n");

    const result = removeManagedBlocks(content);

    expect(result).toContain("line1\n\n\n\nline2");
    expect(result).not.toContain(begin);
    expect(result).not.toContain("generated");
  });

  it("collapses only the seam between adjacent user paragraphs", () => {
    const content = ["before", "", begin, "x", end, "", "after"].join("\n");
    expect(removeManagedBlocks(content)).toBe("before\n\nafter");
  });

  /**
   * Two blocks in one file is not something setup writes, but a merge
   * conflict resolved keeping both sides produces it. The seam collapse ran
   * once per block, and the second pass ate the newline ending the user's own
   * line between them: "MIDDLE\n" came back as "MIDDLE".
   *
   * Removal only ever deletes a block and the two-newline separator setup
   * inserts before one. Spacing around a block xtctx never wrote is not
   * defined, but no byte the user typed may go missing.
   */
  it("loses no user content when a file holds two managed blocks", () => {
    const block = [begin, "x", end].join("\n");
    const content = `${block}\nMIDDLE\n${block}\n`;

    const result = removeManagedBlocks(content);

    expect(result).not.toContain(begin);
    expect(result).toContain("MIDDLE\n");
    // Nothing but the user's line and the newlines that surrounded the blocks.
    expect(result.replace(/\n/g, "")).toBe("MIDDLE");
  });

  it("is idempotent once the blocks are gone", () => {
    const block = [begin, "x", end].join("\n");
    const once = removeManagedBlocks(`${block}\nMIDDLE\n${block}\n`);

    expect(removeManagedBlocks(once)).toBe(once);
  });

  it("counts matched blocks", () => {
    const content = [begin, "a", end, "mid", begin, "b", end].join("\n");
    expect(countManagedBlocks(content)).toBe(2);
  });
});

/**
 * Removal keys purely on the literal marker strings, so a marker interpolated
 * *into* a block ends it early — leaving the block's tail in the file glued to
 * the user's next line, plus a stale end marker that breaks every later run.
 * The reachable route is the project path, which is rendered verbatim and can
 * legally contain the marker text on POSIX.
 */
describe("stripMarkers", () => {
  it("removes an end marker embedded in an interpolated value", () => {
    expect(stripMarkers(`/tmp/${end}/x`)).toBe("/tmp//x");
  });

  it("removes a begin marker too", () => {
    expect(stripMarkers(`/srv/${begin}/p`)).toBe("/srv//p");
  });

  it("leaves ordinary values byte-for-byte alone", () => {
    const path = "H:\\projects\\my-app";
    expect(stripMarkers(path)).toBe(path);
  });

  it("keeps a rendered block removable when the value tried to forge a marker", () => {
    // The whole point: after stripping, the block still has exactly one
    // begin/end pair, so removal takes the block and nothing else.
    const hostile = `/tmp/${end}/x`;
    const block = [begin, `Project root: ${stripMarkers(hostile)}`, "body", end].join("\n");
    const file = `USER TOP\n\n${block}\n`;

    // Removal takes back exactly what setup wrote: the block, the "\n\n"
    // before it, and the single trailing "\n" after the final one.
    expect(countManagedBlocks(file)).toBe(1);
    expect(removeManagedBlocks(file)).toBe("USER TOP");
  });

  it("shows the damage the guard prevents when the value is left raw", () => {
    // Without stripping, the embedded end marker terminates the block early:
    // the block's own tail survives as debris and a stale end marker is left
    // in the file, which then breaks every later run.
    const hostile = `/tmp/${end}/x`;
    const file = `USER TOP\n\n${[begin, `Project root: ${hostile}`, "body", end].join("\n")}\n`;

    expect(countManagedBlocks(file)).toBe(1);
    expect(removeManagedBlocks(file)).toContain("body");
    expect(removeManagedBlocks(file)).toContain(end);
  });
});
