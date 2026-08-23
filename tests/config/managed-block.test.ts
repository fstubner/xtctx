import { describe, expect, it } from "vitest";
import {
  MARKERS,
  countManagedBlocks,
  removeManagedBlocks,
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
