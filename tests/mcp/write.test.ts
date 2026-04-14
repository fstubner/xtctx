import { describe, expect, it } from "vitest";
import { createWriteHandlers } from "@xtctx/mcp/tools/write";
import type { ContextRecord } from "@xtctx/types/context";

describe("write handlers", () => {
  it("saves faq records with faq type", async () => {
    const records: ContextRecord[] = [];

    const handlers = createWriteHandlers({
      async save(record) {
        records.push(record);
      },
    });

    const result = await handlers.saveFaq({
      question: "How do we start a new session?",
      answer: "Call xtctx_search and xtctx_project_knowledge first.",
      context: "Daily workflow",
    });

    expect(result.action).toBe("created");
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe("faq");
    expect(records[0].body).toContain("Q: How do we start a new session?");
    expect(records[0].body).toContain("A: Call xtctx_search and xtctx_project_knowledge first.");
  });
});
