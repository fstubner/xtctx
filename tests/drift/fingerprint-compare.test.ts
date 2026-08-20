import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain Node ESM script helper, no type declarations
import {
  fingerprintsDiffer,
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
