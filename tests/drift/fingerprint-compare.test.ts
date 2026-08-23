import { describe, expect, it } from "vitest";
import {
  fingerprintsDiffer,
  isTransientSidecar,
  mergeFingerprints,
  normalizeFieldEntries,
  serializeFingerprint,
  withoutVolumeCounters,
} from "../../scripts/lib/fingerprint-compare.mjs";

/**
 * The fingerprint check is a drift alarm, and an alarm that fires on an
 * unchanged store is worse than none — it trains the maintainer to ignore it.
 * It fired that way twice, so both causes are pinned here.
 */
describe("fingerprint comparison", () => {
  it("ignores line endings", () => {
    // `core.autocrlf` is on by default on Windows: the committed file can come
    // back off a checkout with CRLF while the script writes LF. That reported
    // a changed format forever, with every line listed as added.
    const lf = '{\n  "kind": "jsonl"\n}\n';
    const crlf = lf.replace(/\n/g, "\r\n");

    expect(fingerprintsDiffer(crlf, lf)).toBe(false);
  });

  it("ignores how much was sampled", () => {
    const before = serializeFingerprint({ kind: "jsonl", recordsSampled: 4372, fields: ["a: string"] });
    const after = serializeFingerprint({ kind: "jsonl", recordsSampled: 4513, fields: ["a: string"] });

    expect(fingerprintsDiffer(before, after)).toBe(false);
  });

  it("strips volume counters at any depth", () => {
    const stripped = withoutVolumeCounters({
      artifactMetadata: { filesSampled: 30, fields: ["summary: string"] },
      nested: [{ recordsSampled: 9, kind: "x" }],
    });

    expect(stripped).toEqual({
      artifactMetadata: { fields: ["summary: string"] },
      nested: [{ kind: "x" }],
    });
  });

  it("still reports a real shape change", () => {
    const before = serializeFingerprint({ kind: "jsonl", fields: ["a: string"] });
    const after = serializeFingerprint({ kind: "jsonl", fields: ["a: string", "b: number"] });

    expect(fingerprintsDiffer(before, after)).toBe(true);
  });
});

/**
 * SQLite writes `-wal` and `-shm` next to a database while it is open, so
 * whether they exist depends on whether the tool happened to be running. A
 * fingerprint that records them reports a format change for having Antigravity
 * open — and accepting that with --write inverts the signal, so it then
 * reports a change for having it closed.
 */
describe("transient sidecar files", () => {
  it("ignores the files SQLite writes while a database is open", () => {
    expect(isTransientSidecar("opencode.db-wal")).toBe(true);
    expect(isTransientSidecar("opencode.db-shm")).toBe(true);
    expect(isTransientSidecar("state.vscdb-journal")).toBe(true);
  });

  it("keeps the database itself and everything else", () => {
    expect(isTransientSidecar("opencode.db")).toBe(false);
    expect(isTransientSidecar("trajectory.pb")).toBe(false);
    expect(isTransientSidecar("walkthrough.md")).toBe(false);
    // Not a sidecar just because the name contains one of those words.
    expect(isTransientSidecar("shm-notes.md")).toBe(false);
  });
});

/**
 * An empty array says nothing about what a field holds, so recording
 * `array<empty>` beside `array<string>` makes the alarm depend on whether the
 * tool happened to write an empty one that day. It fired for
 * `toolUseResult.matches` because a search returned no results.
 */
describe("empty-array entries", () => {
  it("drops the empty variant when the field has a known element type", () => {
    expect(
      normalizeFieldEntries(["a.matches: array<string>", "a.matches: array<empty>"]),
    ).toEqual(["a.matches: array<string>"]);
  });

  it("keeps it when empty is all that has ever been seen", () => {
    expect(normalizeFieldEntries(["a.unknown: array<empty>"])).toEqual([
      "a.unknown: array<empty>",
    ]);
  });

  it("leaves every other entry alone, sorted and deduplicated", () => {
    expect(
      normalizeFieldEntries(["b: string", "a: number", "b: string"]),
    ).toEqual(["a: number", "b: string"]);
  });
});

/**
 * A capture samples the newest files, so the window moves as a tool is used.
 * Record types written a month ago drop out and the check reports them as a
 * change — for having sampled different files, not for anything upstream.
 */
describe("accumulating what is known", () => {
  it("keeps a record type that fell out of the sample window", () => {
    const previous = { recordTypes: { "ai-title": ["aiTitle: string"] } };
    const next = { recordTypes: { user: ["text: string"] } };

    expect(mergeFingerprints(previous, next)).toEqual({
      recordTypes: {
        "ai-title": ["aiTitle: string"],
        user: ["text: string"],
      },
    });
  });

  it("unions the fields of a type seen in both", () => {
    const merged = mergeFingerprints(
      { recordTypes: { user: ["a: string"] } },
      { recordTypes: { user: ["b: number"] } },
    );

    expect(merged.recordTypes.user).toEqual(["a: string", "b: number"]);
  });

  it("takes the newer value for a scalar", () => {
    expect(mergeFingerprints({ kind: "jsonl" }, { kind: "sqlite" })).toEqual({ kind: "sqlite" });
  });
});
