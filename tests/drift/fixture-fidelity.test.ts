import { readFile, mkdtemp, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { shapeOf } from "../../scripts/lib/record-shape.mjs";
import { SEEDERS } from "../smoke/helpers.js";

/**
 * Do the smoke fixtures write what the real tools write?
 *
 * The cross-tool smoke seeds every tool's store and proves the product reads
 * it back — on all three platforms. What it cannot prove is that the seeded
 * shape resembles reality: a fixture that invents a field passes everywhere
 * while proving something about a format no tool produces, and the product
 * still fails for a real user.
 *
 * The committed fingerprints are captured from real stores, so they are the
 * available ground truth. Every field a seeder writes must appear in the
 * fingerprint for that tool and record type.
 *
 * Scope, stated rather than implied: this covers the JSONL tools, where the
 * fingerprint records field paths directly comparable to a seeded record. The
 * SQLite-backed tools (cursor, VS Code Copilot, opencode) and Antigravity are
 * fingerprinted by table schema and directory layout instead, which needs a
 * different comparison and is not attempted here.
 */
const JSONL_TOOLS = ["claude-code", "codex", "copilot-cli"] as const;

interface JsonlFingerprint {
  kind: string;
  recordTypes: Record<string, string[]>;
}

async function readFingerprint(tool: string): Promise<JsonlFingerprint | null> {
  const path = join("tests", "drift", "fingerprints", `${tool}.json`);
  if (!existsSync(path)) {
    return null;
  }
  const parsed = JSON.parse(await readFile(path, "utf-8")) as JsonlFingerprint;
  return parsed.kind === "jsonl" ? parsed : null;
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

describe("smoke fixtures match the real formats", () => {
  for (const tool of JSONL_TOOLS) {
    it(`${tool}: every seeded field exists in a real transcript`, async () => {
      const fingerprint = await readFingerprint(tool);
      expect(fingerprint, `no jsonl fingerprint committed for ${tool}`).not.toBeNull();

      const home = await mkdtemp(join(tmpdir(), `fidelity-home-${tool}-`));
      const projectRoot = await mkdtemp(join(tmpdir(), `fidelity-project-${tool}-`));
      await SEEDERS[tool](home, projectRoot, "FIDELITY-MARKER");

      const unknown: string[] = [];
      let recordsChecked = 0;

      for (const file of (await walk(home)).filter((path) => path.endsWith(".jsonl"))) {
        for (const line of (await readFile(file, "utf-8")).split(/\r?\n/)) {
          if (!line.trim()) continue;
          const record = JSON.parse(line) as { type?: unknown };
          const type = typeof record.type === "string" ? record.type : "(no type field)";
          const known = fingerprint!.recordTypes[type];
          if (!known) {
            unknown.push(`record type "${type}" appears in no real ${tool} transcript`);
            continue;
          }
          recordsChecked += 1;
          for (const entry of shapeOf(record)) {
            // Compare field paths, not their types: a fixture legitimately
            // writes a null where a real transcript held a string, and that is
            // a value difference rather than an invented field.
            const path = entry.slice(0, entry.lastIndexOf(": "));
            if (!known.some((real: string) => real.slice(0, real.lastIndexOf(": ")) === path)) {
              unknown.push(`${type}.${path} appears in no real ${tool} transcript`);
            }
          }
        }
      }

      expect(recordsChecked).toBeGreaterThan(0);
      expect(unknown).toEqual([]);
    });
  }
});
