import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Write via a temp file + rename so an interrupted setup never leaves a
 * truncated config file behind — these writes target files owned by other
 * tools (.mcp.json, config.toml, CLAUDE.md, …), where a partial write is a
 * corruption the owning tool has to recover from.
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.xtctx-tmp`;
  await writeFile(tmpPath, content, "utf-8");
  await rename(tmpPath, filePath);
}
