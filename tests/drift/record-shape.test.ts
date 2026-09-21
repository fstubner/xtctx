/**
 * The shape function the whole drift mechanism is built on.
 *
 * It described an array as `array<object>` and stopped, so anything inside one
 * was invisible — and Claude Code's entire assistant payload is inside one,
 * `message.content[]`. Two records with wholly different element fields
 * produced byte-identical shapes, which meant `capture:formats` reported "no
 * drift" and `fixture-fidelity` accepted invented fields, both without having
 * compared the part that changes.
 *
 * Both callers run inside `verify:release`, so this was a release gate
 * reporting agreement it had never established.
 */
import { describe, expect, it } from "vitest";
import { shapeOf, typeOf } from "../../scripts/lib/record-shape.mjs";

function sorted(value: unknown): string[] {
  return [...shapeOf(value)].sort();
}

describe("shapeOf", () => {
  it("tells apart records whose difference is inside an array", () => {
    const before = sorted({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } });
    const after = sorted({ type: "assistant", message: { content: [{ kind: "prose", body: "hi" }] } });

    expect(before).not.toEqual(after);
    expect(before).toContain("message.content[].type: string");
    expect(after).toContain("message.content[].kind: string");
  });

  it("still records the array's own type, so an array becoming a scalar shows", () => {
    expect(sorted({ content: [{ a: 1 }] })).toContain("content: array<object>");
    expect(sorted({ content: "plain" })).toContain("content: string");
  });

  it("keeps every variant in a heterogeneous array, not just the first", () => {
    const shape = sorted({ content: [{ type: "text" }, { type: "tool_use", name: "Read" }] });

    expect(shape).toContain("content[].type: string");
    expect(shape).toContain("content[].name: string");
  });

  it("redacts data-shaped keys inside array elements too", () => {
    // The reason keys are collapsed at all: cursor stores per-file state under
    // the file's own URI, and a naive walk wrote absolute paths from unrelated
    // private projects into a committed fingerprint. Descending into arrays
    // must not reopen that.
    const shape = sorted({ items: [{ "5f2e8a1b9c3d4e6f": { seen: true } }] });

    expect(shape).toContain("items[].*.seen: boolean");
    expect(shape.join(" ")).not.toContain("5f2e8a1b9c3d4e6f");
  });

  it("does not descend for ever", () => {
    let nested: unknown = { leaf: 1 };
    for (let depth = 0; depth < 12; depth += 1) {
      nested = [{ next: nested }];
    }

    expect(() => shapeOf(nested)).not.toThrow();
    expect([...shapeOf(nested)].every((entry) => entry.split("[]").length <= 8)).toBe(true);
  });

  it("describes an empty array distinctly", () => {
    expect(typeOf([])).toBe("array<empty>");
  });
});
