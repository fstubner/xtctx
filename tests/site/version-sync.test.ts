import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The site publishes the version in its JSON-LD (`softwareVersion`), which
 * search engines index. It drifted from the package version once (0.10.0 vs
 * 0.11.1); this pins the two together. `scripts/sync-version.mjs` keeps
 * version.ts current as part of `npm version`.
 */
describe("site version sync", () => {
  it("matches package.json", async () => {
    const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf-8")) as {
      version: string;
    };
    const versionFile = await readFile(
      join(process.cwd(), "site", "src", "data", "site-content", "version.ts"),
      "utf-8",
    );

    const match = versionFile.match(/productVersion\s*=\s*'([^']+)'/);
    expect(match?.[1]).toBe(pkg.version);
  });
});
