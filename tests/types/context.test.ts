import { describe, it, expect } from "vitest";
import { createContextRecordId, isValidContextType } from "@xtctx/types/context";

describe("ContextRecord", () => {
  it("generates deterministic id from content + source", () => {
    const id1 = createContextRecordId("Use Vitest", "vitest is faster", "claude-code");
    const id2 = createContextRecordId("Use Vitest", "vitest is faster", "claude-code");
    const id3 = createContextRecordId("Use Jest", "jest is reliable", "cursor");
    expect(id1).toBe(id2);
    expect(id1).not.toBe(id3);
  });

  it("validates context types", () => {
    expect(isValidContextType("decision")).toBe(true);
    expect(isValidContextType("error_solution")).toBe(true);
    expect(isValidContextType("insight")).toBe(true);
    expect(isValidContextType("convention")).toBe(true);
    expect(isValidContextType("gotcha")).toBe(true);
    expect(isValidContextType("random")).toBe(false);
  });
});
