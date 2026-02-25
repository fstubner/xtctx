import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export interface SharedToolSection {
  skills: string[];
  commands: string[];
  agents: string[];
}

export interface SharedToolConfig {
  shared: SharedToolSection;
  toolPreferences: Record<string, Record<string, unknown>>;
}

export function getSharedToolConfigPath(projectPath?: string): string {
  const projectRoot = resolve(projectPath ?? process.cwd());
  return join(projectRoot, ".xtctx", "tool-config", "shared.yaml");
}

export async function loadSharedToolConfig(projectPath?: string): Promise<SharedToolConfig> {
  const filePath = getSharedToolConfigPath(projectPath);

  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = parseYaml(raw);
    return normalizeSharedConfig(parsed);
  } catch {
    return createDefaultSharedConfig();
  }
}

function normalizeSharedConfig(input: unknown): SharedToolConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return createDefaultSharedConfig();
  }

  const parsed = input as Record<string, unknown>;
  const shared = normalizeSharedSection(parsed.shared);
  const toolPreferences = normalizeToolPreferences(parsed.toolPreferences);

  return {
    shared,
    toolPreferences,
  };
}

function normalizeSharedSection(input: unknown): SharedToolSection {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      skills: [],
      commands: [],
      agents: [],
    };
  }

  const shared = input as Record<string, unknown>;
  return {
    skills: normalizeStringList(shared.skills),
    commands: normalizeStringList(shared.commands),
    agents: normalizeStringList(shared.agents),
  };
}

function normalizeToolPreferences(
  input: unknown,
): Record<string, Record<string, unknown>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  const source = input as Record<string, unknown>;
  const output: Record<string, Record<string, unknown>> = {};

  for (const [tool, value] of Object.entries(source)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }

    output[tool] = { ...(value as Record<string, unknown>) };
  }

  return output;
}

function normalizeStringList(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function createDefaultSharedConfig(): SharedToolConfig {
  return {
    shared: {
      skills: [],
      commands: [],
      agents: [],
    },
    toolPreferences: {},
  };
}
