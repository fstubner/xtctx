import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const targets = [
  { src: "../src/web/claude-content.ts", dest: "../browser-extension/claude-content.js" },
  { src: "../src/sync/redact.ts", dest: "../browser-extension/redact.js" },
];

for (const { src, dest } of targets) {
  const source = readFileSync(new URL(src, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const header = `// Generated from ${src.slice(3)}; run node scripts/build-web-content.mjs.\n`;
  writeFileSync(new URL(dest, import.meta.url), header + outputText, "utf8");
}
