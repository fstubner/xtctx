/**
 * A Copilot `.jsonl` chat session is a journal: a snapshot record followed by
 * mutation records that each name the key path they write. The path comes out
 * of the file, so it is attacker-controlled, and walking it with plain member
 * access reaches `Object.prototype` through `__proto__` or `constructor`.
 *
 * That is a process-wide primitive, not a parsing nuisance. `better-sqlite3`
 * reads its options with `in`, which traverses the prototype chain, and turns
 * a string `nativeBinding` into a `require()` of that path — so a polluted
 * prototype makes the next database open load an attacker's native module.
 * The scrapers open databases with `{readonly, fileMustExist}` and no own
 * `nativeBinding` key, which is exactly the shape that inherits one.
 */
import { afterEach, describe, expect, it } from "vitest";
import { parseChatSessionFile } from "@xtctx/scrapers/copilot";

/** Keys that must never be writable through a journal key path. */
const POLLUTION_PROBES = ["xtctxPwned", "nativeBinding", "timeout"] as const;

function journal(path: Array<string | number>, value: unknown): string {
  return [
    JSON.stringify({ kind: 0, v: { requests: [] } }),
    JSON.stringify({ kind: 1, k: path, v: value }),
  ].join("\n");
}

/** Drain the generator — replay only happens as it is consumed. */
function replay(raw: string): unknown[] {
  return [...parseChatSessionFile(raw, "s.jsonl", "fixture://copilot")];
}

describe("copilot journal replay: prototype pollution", () => {
  afterEach(() => {
    // Undo anything a regression leaks, so one failure cannot cascade into
    // unrelated suites sharing this process.
    for (const key of POLLUTION_PROBES) {
      delete (Object.prototype as Record<string, unknown>)[key];
    }
  });

  it("does not let a __proto__ key path reach Object.prototype", () => {
    const raw = journal(["__proto__", "xtctxPwned"], "yes");

    replay(raw);

    expect(({} as Record<string, unknown>).xtctxPwned).toBeUndefined();
  });

  it("does not let a constructor.prototype key path reach Object.prototype", () => {
    const raw = journal(["constructor", "prototype", "xtctxPwned"], "yes");

    replay(raw);

    expect(({} as Record<string, unknown>).xtctxPwned).toBeUndefined();
  });

  it("does not let a poisoned prototype reach better-sqlite3 option lookups", () => {
    // `'nativeBinding' in options` and `'timeout' in options` both traverse
    // the prototype chain, so an inherited key is enough — the option object
    // xtctx passes never owns these names.
    const raw = journal(["__proto__", "nativeBinding"], "/tmp/evil.node");

    replay(raw);

    expect("nativeBinding" in {}).toBe(false);
  });

  it("still applies ordinary key paths so the guard is not a blanket refusal", () => {
    // The fix must reject the dangerous segments only. A journal that sets a
    // normal field has to keep working, or replay is broken rather than safe.
    const raw = journal(["customTitle"], "renamed session");

    const [session] = replay(raw);

    expect((session as Record<string, unknown>).customTitle).toBe("renamed session");
  });
});
