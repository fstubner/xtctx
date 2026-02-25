import { cp, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = process.cwd();
const sourceDir = resolve(root, "web", "dist");
const targetDir = resolve(root, "dist", "web");
const sourceIndex = join(sourceDir, "index.html");

await assertExists(sourceDir, "directory");
await assertExists(sourceIndex, "file");

await rm(targetDir, { recursive: true, force: true });
await cp(sourceDir, targetDir, { recursive: true });

console.log(`Copied web build artifact: ${sourceDir} -> ${targetDir}`);

async function assertExists(path, expectedType) {
  try {
    const result = await stat(path);
    const valid =
      expectedType === "directory" ? result.isDirectory() : result.isFile();
    if (!valid) {
      throw new Error(`Expected ${expectedType} at ${path}.`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Missing required web build artifact at ${path}. Run \`npm --prefix web run build\` first. (${message})`,
    );
  }
}
