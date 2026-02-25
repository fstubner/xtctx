import { describe, it, expect } from "vitest";
import { checkDuplicate } from "@xtctx/knowledge/dedup";

describe("dedup", () => {
  it("detects near-duplicates (score > 0.95)", () => {
    const result = checkDuplicate(0.97, "existing-id");
    expect(result.action).toBe("duplicate_rejected");
    expect(result.existingId).toBe("existing-id");
  });

  it("detects supersession (score 0.85-0.95)", () => {
    const result = checkDuplicate(0.9, "old-id");
    expect(result.action).toBe("superseded");
    expect(result.existingId).toBe("old-id");
  });

  it("allows new records (score < 0.85)", () => {
    const result = checkDuplicate(0.7, "other-id");
    expect(result.action).toBe("created");
  });

  it("allows new records when no similar found", () => {
    const result = checkDuplicate(0, null);
    expect(result.action).toBe("created");
  });
});
