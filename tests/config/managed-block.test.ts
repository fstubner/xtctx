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

  it("counts matched blocks", () => {
    const content = [begin, "a", end, "mid", begin, "b", end].join("\n");
    expect(countManagedBlocks(content)).toBe(2);
  });
});
