/**
 * A `compacted` record inlines the whole prior conversation in
 * `replacement_history`, so it is routinely tens of megabytes. Measured on a
 * real 865MB transcript: 47 of 21,109 lines exceeded the 8MB cap, the largest
 * 22.4MB, and every one was `compacted`.
 *
 * Skipping them loses nothing — the turns they restate are already indexed
 * from the `response_item` and `event_msg` records they were copied from
 * (1,842 and 1,667 of them in the first 4,001 records of that same file). What
 * did cost something was reporting each one as drift on every scan: a warning
 * that fires forever for a known, benign shape is the crying-wolf failure this
 * project already made once with `atis-latch`.
 */
import { describe, expect, it } from "vitest";
import { isKnownBulkyRecord } from "@xtctx/scrapers/codex";

const line = (type: string): string =>
  `{"timestamp":"2026-02-26T18:08:43.215Z","type":"${type}","payload":{"message":""}}`;

describe("codex oversized-record classification", () => {
  it("recognises a compacted record", () => {
    expect(isKnownBulkyRecord(line("compacted"))).toBe(true);
  });

  it("does not silence an oversized record of any other type", () => {
    // The cap firing on these is real drift: nothing else is expected to be
    // this large, so it means a format changed and someone should look.
    for (const type of ["response_item", "event_msg", "turn_context", "session_meta"]) {
      expect(isKnownBulkyRecord(line(type)), type).toBe(false);
    }
  });

  it("does not silence a line whose type is unreadable", () => {
    expect(isKnownBulkyRecord("not json at all")).toBe(false);
    expect(isKnownBulkyRecord("{}")).toBe(false);
  });

  it("only inspects the head, so a type named deep in a huge line is ignored", () => {
    // The point of reading the head is avoiding the parse the cap exists to
    // prevent. A `compacted` string buried in a payload must not silence a
    // record whose own type is something else.
    const buried = `{"timestamp":"2026-02-26T18:08:43.215Z","type":"response_item","payload":{"text":"${"x".repeat(400)}","note":"compacted"}}`;
    expect(isKnownBulkyRecord(buried)).toBe(false);
  });
});
