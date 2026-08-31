/**
 * The reader exists because `readline` cannot report byte offsets and cannot
 * refuse a line before materialising it. Both matter here: a real Codex store
 * holds 18GB across 841 files with 94% of it in 17, so every scan re-read all
 * of it, and the existing 8MB cap was rejecting 22MB lines only after they had
 * already been buffered.
 */
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsonlLines } from "@xtctx/scrapers/jsonl-reader";

describe("readJsonlLines", () => {
  let dir = "";
  let file = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "xtctx-jsonl-"));
    file = join(dir, "t.jsonl");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function readAll(start?: number): Promise<{ lines: (string | null)[]; end: number }> {
    const lines: (string | null)[] = [];
    let end = start ?? 0;
    for await (const item of readJsonlLines(file, { start })) {
      lines.push(item.line);
      end = item.endOffset;
    }
    return { lines, end };
  }

  it("reads every line and reports the offset past the last newline", async () => {
    await writeFile(file, '{"a":1}\n{"b":2}\n');
    const { lines, end } = await readAll();
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(end).toBe(16);
  });

  it("resumes from an offset, reading only what was appended", async () => {
    // The reason this exists: an 18GB store should cost the size of its tail.
    await writeFile(file, '{"a":1}\n');
    const first = await readAll();
    await appendFile(file, '{"b":2}\n');
    const second = await readAll(first.end);
    expect(second.lines).toEqual(['{"b":2}']);
  });

  it("counts bytes, not characters, so multi-byte content cannot drift the offset", async () => {
    // A line's String.length is UTF-16 units. Deriving an offset from it walks
    // the resume point into the middle of a line on any non-ASCII content.
    const text = '{"t":"héllo → 世界"}';
    await writeFile(file, `${text}\n{"next":true}\n`);
    const first: number[] = [];
    for await (const item of readJsonlLines(file)) first.push(item.endOffset);
    expect(first[0]).toBe(Buffer.byteLength(text, "utf-8") + 1);
    expect(first[0]).not.toBe(text.length + 1);

    const { lines } = await readAll(first[0]);
    expect(lines).toEqual(['{"next":true}']);
  });

  it("does not yield or count a trailing line with no newline", async () => {
    // A file being appended to as we read. Counting the partial line would
    // resume past a record that was never delivered.
    await writeFile(file, '{"a":1}\n{"partial":');
    const { lines, end } = await readAll();
    expect(lines).toEqual(['{"a":1}']);
    expect(end).toBe(8);

    await appendFile(file, 'true}\n');
    expect((await readAll(end)).lines).toEqual(['{"partial":true}']);
  });

  it("discards an oversized line without holding it, and keeps the offset right", async () => {
    const big = `{"x":"${"y".repeat(5000)}"}`;
    await writeFile(file, `{"a":1}\n${big}\n{"b":2}\n`);

    const seen: Array<{ line: string | null; oversized: boolean }> = [];
    for await (const item of readJsonlLines(file, { maxLineBytes: 1000 })) {
      seen.push({ line: item.line, oversized: item.oversized });
    }

    expect(seen.map((s) => s.oversized)).toEqual([false, true, false]);
    expect(seen[1].line).toBeNull();
    // The lines either side still arrive: one huge record must not cost the
    // rest of the file.
    expect(seen.map((s) => s.line)).toEqual(['{"a":1}', null, '{"b":2}']);
  });

  it("handles an oversized line that spans many chunks", async () => {
    // The discard path has to survive the line arriving in pieces, which is
    // the only way a 22MB line ever arrives.
    const big = `{"x":"${"y".repeat(400_000)}"}`;
    await writeFile(file, `${big}\n{"after":true}\n`);
    const seen: Array<string | null> = [];
    for await (const item of readJsonlLines(file, { maxLineBytes: 1000 })) seen.push(item.line);
    expect(seen).toEqual([null, '{"after":true}']);
  });

  it("returns nothing when resumed at end of file", async () => {
    await writeFile(file, '{"a":1}\n');
    const first = await readAll();
    expect((await readAll(first.end)).lines).toEqual([]);
  });
});
