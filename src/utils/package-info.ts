import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the xtctx package.json by walking up from the caller's module URL
 * until a package.json with name === "xtctx" is found. Works identically
 * whether the caller lives in `src/...` (tsx dev mode), `dist/src/...`
 * (post-build in-tree), or `node_modules/xtctx/dist/src/...` (installed).
 */
export function readXtctxPackage(callerUrl: string): { version: string; name: string } {
  let dir = dirname(fileURLToPath(callerUrl));
  for (let depth = 0; depth < 8; depth++) {
    try {
      const raw = readFileSync(join(dir, "package.json"), "utf8");
      const pkg = JSON.parse(raw) as { name?: string; version?: string };
      if (pkg.name === "xtctx" && typeof pkg.version === "string") {
        return { name: pkg.name, version: pkg.version };
      }
    } catch {
      // not here; keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate xtctx package.json from ${callerUrl}`);
}
