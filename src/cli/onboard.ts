/**
 * `xtctx onboard` — interactive first-run wizard.
 *
 * Replaces the "dump 60-line YAML and walk away" experience of bare
 * `xtctx init` with a short guided flow:
 *
 *   1. Multiselect of which AI coding tools xtctx should know about,
 *      preselected with whatever was auto-detected on this machine.
 *   2. Continuity scope — project-only or hybrid (project + global).
 *   3. Whitelist policy advisory level — warn or strict-hint.
 *   4. Confirm: run `xtctx sync` and `xtctx serve` next?
 *
 * The wizard reuses `runInit` for directory scaffolding, then overwrites
 * `.xtctx/tool-config/shared.yaml` with a tailored YAML based on the answers.
 *
 * Non-interactive escape hatches:
 *   --yes          accept defaults, skip all prompts (CI / scripted setup)
 *   --no-detect    skip auto-detection, enable all 7 tools instead
 *
 * UI is delegated to `@clack/prompts` so we get spinners, properly styled
 * multiselect, and cancel handling for free.  We branch on isCancel for
 * every prompt so Ctrl-C exits gracefully rather than throwing.
 */
import { access, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  intro,
  outro,
  multiselect,
  select,
  confirm,
  spinner,
  isCancel,
  cancel,
  log,
  note,
} from "@clack/prompts";
import {
  defaultClaudeProjectsDir,
  defaultCursorStorePath,
  defaultCodexSessionsPath,
  defaultCopilotHistoryPath,
  defaultGeminiHistoryPath,
  defaultOpenCodeStorePath,
  defaultCopilotCliSessionPath,
} from "../runtime/ingestion.js";
import { runInit } from "./init.js";

export interface OnboardOptions {
  projectPath?: string;
  yes?: boolean;
  noDetect?: boolean;
}

/** Tools the wizard knows how to detect. Order = display order. */
const KNOWN_TOOLS = [
  { id: "claude-code", display: "Claude Code", path: defaultClaudeProjectsDir },
  { id: "cursor", display: "Cursor", path: defaultCursorStorePath },
  { id: "codex", display: "Codex CLI", path: defaultCodexSessionsPath },
  { id: "copilot", display: "Copilot (VS Code)", path: defaultCopilotHistoryPath },
  { id: "gemini", display: "Gemini CLI", path: defaultGeminiHistoryPath },
  { id: "opencode", display: "opencode", path: defaultOpenCodeStorePath },
  { id: "copilot-cli", display: "Copilot CLI", path: defaultCopilotCliSessionPath },
] as const;

interface ToolDetection {
  id: string;
  display: string;
  path: string;
  found: boolean;
}

type Scope = "project" | "hybrid";
type AdvisoryLevel = "warn" | "strict-hint";

interface OnboardAnswers {
  enabledTools: Set<string>;
  scope: Scope;
  advisoryLevel: AdvisoryLevel;
  runSyncAndServe: boolean;
}

export async function runOnboard(options: OnboardOptions = {}): Promise<void> {
  const projectRoot = resolve(options.projectPath ?? process.cwd());

  intro("xtctx onboard — interactive setup");
  log.info(`project: ${projectRoot}`);

  const detections = await detectStep(options.noDetect ?? false);

  const answers = options.yes
    ? defaultAnswersFor(detections)
    : await askInteractive(detections);

  const scaffold = spinner();
  scaffold.start("Scaffolding .xtctx/");
  // Silent so runInit's own status line doesn't leak through the spinner.
  await runInit({ projectPath: projectRoot, force: false, silent: true });
  const sharedYamlPath = join(projectRoot, ".xtctx", "tool-config", "shared.yaml");
  await writeFile(sharedYamlPath, renderSharedYaml(answers, detections), "utf-8");
  scaffold.stop(`Wrote ${sharedYamlPath}`);

  note(summaryBody(answers), "Summary");

  if (answers.runSyncAndServe) {
    outro(
      "Next: run `xtctx sync` to write per-tool configs, then `xtctx serve` to start the MCP server.",
    );
  } else {
    outro("Run `xtctx sync` when you're ready to write per-tool configs.");
  }
}

/* ---------- detection ---------- */

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function detectStep(skipDetection: boolean): Promise<ToolDetection[]> {
  if (skipDetection) {
    return KNOWN_TOOLS.map((t) => ({
      id: t.id,
      display: t.display,
      path: t.path(),
      found: true,
    }));
  }

  const s = spinner();
  s.start("Looking for installed AI coding tools");
  const detections = await Promise.all(
    KNOWN_TOOLS.map(async (t) => ({
      id: t.id,
      display: t.display,
      path: t.path(),
      found: await pathExists(t.path()),
    })),
  );
  const foundCount = detections.filter((d) => d.found).length;
  s.stop(
    foundCount === 0
      ? "No tools auto-detected (you can still enable them manually)"
      : `Detected ${foundCount} of ${detections.length} tools`,
  );
  return detections;
}

/* ---------- interactive prompts ---------- */

async function askInteractive(detections: ToolDetection[]): Promise<OnboardAnswers> {
  const found = detections.filter((d) => d.found);

  const toolChoice = await multiselect({
    message: "Which tools should xtctx sync into?",
    options: detections.map((d) => ({
      value: d.id,
      label: d.display,
      hint: d.found ? "detected" : "not detected on this machine",
    })),
    initialValues:
      found.length > 0 ? found.map((d) => d.id) : detections.map((d) => d.id),
    required: false,
  });
  exitIfCancelled(toolChoice);

  const scopeChoice = await select<Scope>({
    message: "Continuity scope",
    options: [
      { value: "project", label: "project", hint: "sync only into this project's tools" },
      {
        value: "hybrid",
        label: "hybrid",
        hint: "sync into this project AND your global config",
      },
    ],
    initialValue: "project",
  });
  exitIfCancelled(scopeChoice);

  const advisoryChoice = await select<AdvisoryLevel>({
    message: "Whitelist policy advisory level",
    options: [
      {
        value: "warn",
        label: "warn",
        hint: "tell the assistant about denied patterns, never block",
      },
      {
        value: "strict-hint",
        label: "strict-hint",
        hint: "stronger language, still won't block",
      },
    ],
    initialValue: "warn",
  });
  exitIfCancelled(advisoryChoice);

  const runChoice = await confirm({
    message: "Ready to wire up your tools after this?",
    initialValue: true,
  });
  exitIfCancelled(runChoice);

  return {
    enabledTools: new Set(toolChoice as string[]),
    scope: scopeChoice as Scope,
    advisoryLevel: advisoryChoice as AdvisoryLevel,
    runSyncAndServe: Boolean(runChoice),
  };
}

function exitIfCancelled(value: unknown): void {
  if (isCancel(value)) {
    cancel("Cancelled. Nothing was written.");
    process.exit(0);
  }
}

/* ---------- non-interactive defaults ---------- */

function defaultAnswersFor(detections: ToolDetection[]): OnboardAnswers {
  const found = detections.filter((d) => d.found);
  const enabled =
    found.length > 0 ? found.map((d) => d.id) : detections.map((d) => d.id);
  return {
    enabledTools: new Set(enabled),
    scope: "project",
    advisoryLevel: "warn",
    runSyncAndServe: true,
  };
}

/* ---------- YAML rendering ---------- */

/**
 * Render a `shared.yaml` reflecting the wizard answers. Disabled tools
 * are still listed (with `enabled: false`) rather than omitted, so users
 * can flip them on later by hand-editing without remembering the schema.
 */
export function renderSharedYaml(
  answers: OnboardAnswers,
  detections: ToolDetection[],
): string {
  const lines: string[] = [];
  lines.push(`defaults:`);
  lines.push(`  sync_enabled: true`);
  lines.push(`  categories_enabled:`);
  for (const cat of [
    "context_feed",
    "skills",
    "commands",
    "agents",
    "mcp_servers",
    "slash_commands",
    "whitelist_policy",
  ]) {
    lines.push(`    - ${cat}`);
  }
  lines.push(`  scope: ${answers.scope === "hybrid" ? "hybrid" : "project"}`);

  lines.push(`tools:`);
  for (const detection of detections) {
    const enabled = answers.enabledTools.has(detection.id);
    // The policy schema uses `claude` for Claude Code; everything else
    // matches the detection id directly.
    const slug = detection.id === "claude-code" ? "claude" : detection.id;
    lines.push(`  ${slug}:`);
    lines.push(`    enabled: ${enabled}`);
    lines.push(`    scope: ${answers.scope === "hybrid" ? "hybrid" : "project"}`);
    lines.push(`    categories: {}`);
    lines.push(`    preferences: {}`);
  }

  lines.push(`policy:`);
  lines.push(`  whitelist:`);
  lines.push(`    allowed_patterns: []`);
  lines.push(`    denied_patterns: []`);
  lines.push(`    advisory_level: ${answers.advisoryLevel}`);

  return lines.join("\n") + "\n";
}

/* ---------- presentation helpers ---------- */

function summaryBody(answers: OnboardAnswers): string {
  const enabled = [...answers.enabledTools];
  return [
    `Tools enabled    ${enabled.length} (${enabled.join(", ") || "none"})`,
    `Scope            ${answers.scope}`,
    `Advisory level   ${answers.advisoryLevel}`,
  ].join("\n");
}
