/**
 * Regenerate the plugin package's skill from the one `setup` writes.
 *
 * The plugin ships a committed `SKILL.md` because clients install it by
 * cloning the repo; there is no build step between the repo and the user. So
 * the file has to be checked in, and a checked-in copy of generated content
 * drifts. This rewrites it, and `tests/release/plugin-package.test.ts` fails
 * when it has been left stale.
 *
 *   node scripts/sync-plugin-skill.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { builtInHandoffSkill } from "../dist/src/config/skills.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "plugin", "skills", "xtctx-handoff", "SKILL.md");
writeFileSync(target, builtInHandoffSkill(), "utf-8");
console.log(`wrote ${target}`);
