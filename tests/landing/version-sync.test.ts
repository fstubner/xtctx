import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The landing site publishes the version in its footer and in JSON-LD
 * (`softwareVersion`), which search engines index. It drifted from the
 * package version once (0.10.0 vs 0.11.1); this pins the two together.
 * release-please keeps site.ts current via its extra-files updater.
 */
describe("landing version sync", () => {
  it("matches package.json", async () => {
    const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf-8")) as {
      version: string;
    };
    const siteData = await readFile(
      join(process.cwd(), "landing", "src", "data", "site.ts"),
      "utf-8",
    );

    const match = siteData.match(/version:\s*'([^']+)'/);
    expect(match?.[1]).toBe(pkg.version);
  });
});
