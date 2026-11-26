#!/usr/bin/env node
import AdmZip from "adm-zip";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const rootDir = process.cwd();
const extDir = resolve(rootDir, "browser-extension");
const distDir = resolve(rootDir, "dist");
const outFile = join(distDir, "xtctx-browser-extension.zip");

const REQUIRED_FILES = [
  "manifest.json",
  "background.js",
  "backfill.html",
  "backfill.js",
  "capture.js",
  "claude-content.js",
  "gemini-reader.js",
  "popup.css",
  "popup.html",
  "popup.js",
  "redact.js",
  "icons/icon-128.png",
];

function fail(message) {
  console.error(`pack:extension failed: ${message}`);
  process.exit(1);
}

const manifestPath = join(extDir, "manifest.json");
if (!existsSync(manifestPath)) fail("missing browser-extension/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

if (manifest.icons?.["128"] !== "icons/icon-128.png") {
  fail('manifest.json must declare icons["128"] = "icons/icon-128.png"');
}
if (Array.isArray(manifest.permissions) && manifest.permissions.includes("nativeMessaging")) {
  fail('manifest.json must not request "nativeMessaging" in required permissions');
}
if (!Array.isArray(manifest.optional_permissions) || !manifest.optional_permissions.includes("nativeMessaging")) {
  fail('manifest.json must declare "nativeMessaging" in optional_permissions');
}

const zip = new AdmZip();
for (const rel of REQUIRED_FILES) {
  const full = join(extDir, rel);
  if (!existsSync(full) || !statSync(full).isFile()) {
    fail(`missing required extension asset: ${rel}`);
  }
  const zipDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  zip.addLocalFile(full, zipDir);
}

mkdirSync(distDir, { recursive: true });
zip.writeZip(outFile);

const checkZip = new AdmZip(outFile);
const entries = new Set(checkZip.getEntries().map((e) => e.entryName));
for (const rel of REQUIRED_FILES) {
  if (!entries.has(rel)) fail(`zip verification missing entry: ${rel}`);
}
if (entries.has("install-native-windows.ps1")) {
  fail("zip must not contain install-native-windows.ps1");
}

console.log(`Packed ${entries.size} extension files to ${outFile}`);
