import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = process.cwd();
const source = resolve(root, "src", "api", "static");
const target = resolve(root, "dist", "src", "api", "static");

await mkdir(dirname(target), { recursive: true });
await cp(source, target, { recursive: true });

console.log(`Copied static assets: ${source} -> ${target}`);
