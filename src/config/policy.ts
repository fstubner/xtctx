import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const CONTINUITY_CATEGORIES = [
  "context_feed",
  "skills",
  "commands",
  "agents",
  "mcp_servers",
  "slash_commands",
  "whitelist_policy",
] as const;

export const CONTINUITY_SCOPES = ["project", "global", "hybrid"] as const;
export const ADVISORY_LEVELS = ["warn", "strict-hint"] as const;
export const DEFAULT_REGISTERED_TOOLS = [
  "claude",
  "cursor",
  "codex",
  "copilot",
  "gemini",
] as const;

const ROOT_KEYS = new Set(["defaults", "tools", "policy"]);
const DEFAULTS_KEYS = new Set(["sync_enabled", "categories_enabled", "scope"]);
const TOOL_KEYS = new Set(["enabled", "scope", "categories", "preferences"]);
const POLICY_KEYS = new Set(["whitelist"]);
const WHITELIST_KEYS = new Set(["allowed_patterns", "denied_patterns", "advisory_level"]);

export type ContinuityCategory = (typeof CONTINUITY_CATEGORIES)[number];
export type ContinuityScope = (typeof CONTINUITY_SCOPES)[number];
export type AdvisoryLevel = (typeof ADVISORY_LEVELS)[number];

export interface ContinuityDefaults {
  sync_enabled: boolean;
  categories_enabled: ContinuityCategory[];
  scope: ContinuityScope;
}

export interface WhitelistPolicy {
  allowed_patterns: string[];
  denied_patterns: string[];
  advisory_level: AdvisoryLevel;
}

export interface ToolContinuityPolicy {
  enabled: boolean;
  scope: ContinuityScope;
  categories: Record<ContinuityCategory, boolean>;
  preferences: Record<string, unknown>;
}

export interface ToolPolicyOverrides {
  enabled?: boolean;
  scope?: ContinuityScope;
  categories?: Partial<Record<ContinuityCategory, boolean>>;
  preferences?: Record<string, unknown>;
}

export interface ContinuityPolicyLayer {
  defaults: Partial<ContinuityDefaults>;
  tools: Record<string, ToolPolicyOverrides>;
  policy: {
    whitelist: Partial<WhitelistPolicy>;
  };
}

export interface ResolvedContinuityPolicy {
  defaults: ContinuityDefaults;
  tools: Record<string, ToolContinuityPolicy>;
  policy: {
    whitelist: WhitelistPolicy;
  };
}

export interface EffectiveContinuityPolicy extends ResolvedContinuityPolicy {
  source_layers: Array<{
    layer: "global" | "repo";
    path: string;
    loaded: boolean;
  }>;
  resolved_at: string;
}

export interface MergeContinuityPolicyOptions {
  registeredTools?: string[];
}

export class ContinuityPolicyValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(`Invalid continuity policy:\n- ${errors.join("\n- ")}`);
    this.name = "ContinuityPolicyValidationError";
  }
}

export function getRepoContinuityPolicyPath(projectPath?: string): string {
  const projectRoot = resolve(projectPath ?? process.cwd());
  return join(projectRoot, ".xtctx", "tool-config", "shared.yaml");
}

export function getGlobalContinuityPolicyPath(homeDir?: string): string {
  const home = homeDir ?? process.env.USERPROFILE ?? process.env.HOME;
  if (!home) {
    return resolve(".xtctx", "global-policy.yaml");
  }

  return join(resolve(home), ".xtctx", "global-policy.yaml");
}

export async function loadEffectiveContinuityPolicy(
  projectPath?: string,
  options: MergeContinuityPolicyOptions = {},
): Promise<EffectiveContinuityPolicy> {
  const globalPath = getGlobalContinuityPolicyPath();
  const repoPath = getRepoContinuityPolicyPath(projectPath);

  const [globalLayer, repoLayer] = await Promise.all([
    loadContinuityPolicyLayer(globalPath, "global"),
    loadContinuityPolicyLayer(repoPath, "repo"),
  ]);

  const resolved = mergeContinuityPolicyLayers(globalLayer, repoLayer, options);

  return {
    ...resolved,
    source_layers: [
      { layer: "global", path: globalPath, loaded: globalLayer !== null },
      { layer: "repo", path: repoPath, loaded: repoLayer !== null },
    ],
    resolved_at: new Date().toISOString(),
  };
}

export async function loadRepoContinuityPolicyLayer(
  projectPath?: string,
): Promise<ContinuityPolicyLayer> {
  const path = getRepoContinuityPolicyPath(projectPath);
  const layer = await loadContinuityPolicyLayer(path, "repo");
  return layer ?? createEmptyLayer();
}

export async function writeRepoContinuityPolicyLayer(
  layer: ContinuityPolicyLayer,
  projectPath?: string,
): Promise<void> {
  const filePath = getRepoContinuityPolicyPath(projectPath);
  const normalized = normalizeLayerForWrite(layer);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${stringifyYaml(normalized).trimEnd()}\n`, "utf-8");
}

export function mergeContinuityPolicyLayers(
  globalLayer: ContinuityPolicyLayer | null | undefined,
  repoLayer: ContinuityPolicyLayer | null | undefined,
  options: MergeContinuityPolicyOptions = {},
): ResolvedContinuityPolicy {
  const defaults = mergeDefaults(globalLayer?.defaults, repoLayer?.defaults);
  const whitelist = mergeWhitelist(
    globalLayer?.policy.whitelist,
    repoLayer?.policy.whitelist,
  );

  const toolNames = dedupeStrings([
    ...(options.registeredTools ?? DEFAULT_REGISTERED_TOOLS),
    ...Object.keys(globalLayer?.tools ?? {}),
    ...Object.keys(repoLayer?.tools ?? {}),
  ]);

  const tools: Record<string, ToolContinuityPolicy> = {};
  for (const tool of toolNames) {
    tools[tool] = resolveToolPolicy(
      defaults,
      globalLayer?.tools[tool],
      repoLayer?.tools[tool],
    );
  }

  return {
    defaults,
    tools,
    policy: { whitelist },
  };
}

export function resolveToolFromPolicy(
  policy: ResolvedContinuityPolicy,
  tool: string,
): ToolContinuityPolicy {
  const existing = policy.tools[tool];
  if (existing) {
    return existing;
  }

  return resolveToolPolicy(policy.defaults, undefined, undefined);
}

export function parseContinuityPolicySource(
  source: unknown,
  sourceLabel = "policy",
): ContinuityPolicyLayer {
  const errors: string[] = [];
  if (!isRecord(source)) {
    if (source == null) {
      return createEmptyLayer();
    }
    throw new ContinuityPolicyValidationError([`${sourceLabel}: expected object`]);
  }

  rejectUnknownKeys(source, ROOT_KEYS, sourceLabel, errors);

  const defaults = parseDefaults(source.defaults, `${sourceLabel}.defaults`, errors);
  const tools = parseTools(source.tools, `${sourceLabel}.tools`, errors);
  const policy = parsePolicy(source.policy, `${sourceLabel}.policy`, errors);

  if (errors.length > 0) {
    throw new ContinuityPolicyValidationError(errors);
  }

  return {
    defaults,
    tools,
    policy,
  };
}

export async function loadContinuityPolicyLayer(
  filePath: string,
  layerName: "global" | "repo",
): Promise<ContinuityPolicyLayer | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = parseYaml(raw);
    return parseContinuityPolicySource(parsed, `${layerName}:${filePath}`);
  } catch (error) {
    if (isFileMissingError(error)) {
      return null;
    }
    throw error;
  }
}

function parseDefaults(
  input: unknown,
  path: string,
  errors: string[],
): Partial<ContinuityDefaults> {
  if (input == null) {
    return {};
  }

  if (!isRecord(input)) {
    errors.push(`${path}: expected object`);
    return {};
  }

  rejectUnknownKeys(input, DEFAULTS_KEYS, path, errors);

  const parsed: Partial<ContinuityDefaults> = {};
  if ("sync_enabled" in input) {
    if (typeof input.sync_enabled === "boolean") {
      parsed.sync_enabled = input.sync_enabled;
    } else {
      errors.push(`${path}.sync_enabled: expected boolean`);
    }
  }

  if ("categories_enabled" in input) {
    const categories = parseCategoryList(input.categories_enabled, `${path}.categories_enabled`, errors);
    parsed.categories_enabled = categories;
  }

  if ("scope" in input) {
    if (isScope(input.scope)) {
      parsed.scope = input.scope;
    } else {
      errors.push(`${path}.scope: expected one of ${CONTINUITY_SCOPES.join(", ")}`);
    }
  }

  return parsed;
}

function parseTools(
  input: unknown,
  path: string,
  errors: string[],
): Record<string, ToolPolicyOverrides> {
  if (input == null) {
    return {};
  }

  if (!isRecord(input)) {
    errors.push(`${path}: expected object`);
    return {};
  }

  const tools: Record<string, ToolPolicyOverrides> = {};
  for (const [toolName, rawTool] of Object.entries(input)) {
    const toolPath = `${path}.${toolName}`;
    if (!isRecord(rawTool)) {
      errors.push(`${toolPath}: expected object`);
      continue;
    }

    rejectUnknownKeys(rawTool, TOOL_KEYS, toolPath, errors);

    const parsed: ToolPolicyOverrides = {};
    if ("enabled" in rawTool) {
      if (typeof rawTool.enabled === "boolean") {
        parsed.enabled = rawTool.enabled;
      } else {
        errors.push(`${toolPath}.enabled: expected boolean`);
      }
    }

    if ("scope" in rawTool) {
      if (isScope(rawTool.scope)) {
        parsed.scope = rawTool.scope;
      } else {
        errors.push(`${toolPath}.scope: expected one of ${CONTINUITY_SCOPES.join(", ")}`);
      }
    }

    if ("categories" in rawTool) {
      parsed.categories = parseCategoryMap(rawTool.categories, `${toolPath}.categories`, errors);
    }

    if ("preferences" in rawTool) {
      if (isRecord(rawTool.preferences)) {
        parsed.preferences = { ...rawTool.preferences };
      } else {
        errors.push(`${toolPath}.preferences: expected object`);
      }
    }

    tools[toolName] = parsed;
  }

  return tools;
}

function parsePolicy(
  input: unknown,
  path: string,
  errors: string[],
): { whitelist: Partial<WhitelistPolicy> } {
  if (input == null) {
    return { whitelist: {} };
  }

  if (!isRecord(input)) {
    errors.push(`${path}: expected object`);
    return { whitelist: {} };
  }

  rejectUnknownKeys(input, POLICY_KEYS, path, errors);
  const whitelist = parseWhitelist(input.whitelist, `${path}.whitelist`, errors);

  return { whitelist };
}

function parseWhitelist(
  input: unknown,
  path: string,
  errors: string[],
): Partial<WhitelistPolicy> {
  if (input == null) {
    return {};
  }

  if (!isRecord(input)) {
    errors.push(`${path}: expected object`);
    return {};
  }

  rejectUnknownKeys(input, WHITELIST_KEYS, path, errors);

  const parsed: Partial<WhitelistPolicy> = {};
  if ("allowed_patterns" in input) {
    parsed.allowed_patterns = parseStringList(input.allowed_patterns, `${path}.allowed_patterns`, errors);
  }

  if ("denied_patterns" in input) {
    parsed.denied_patterns = parseStringList(input.denied_patterns, `${path}.denied_patterns`, errors);
  }

  if ("advisory_level" in input) {
    if (isAdvisoryLevel(input.advisory_level)) {
      parsed.advisory_level = input.advisory_level;
    } else {
      errors.push(`${path}.advisory_level: expected one of ${ADVISORY_LEVELS.join(", ")}`);
    }
  }

  return parsed;
}

function mergeDefaults(
  globalDefaults: Partial<ContinuityDefaults> | undefined,
  repoDefaults: Partial<ContinuityDefaults> | undefined,
): ContinuityDefaults {
  const categories = repoDefaults?.categories_enabled
    ?? globalDefaults?.categories_enabled
    ?? [...CONTINUITY_CATEGORIES];

  return {
    sync_enabled: repoDefaults?.sync_enabled ?? globalDefaults?.sync_enabled ?? true,
    categories_enabled: dedupeCategories(categories),
    scope: repoDefaults?.scope ?? globalDefaults?.scope ?? "project",
  };
}

function mergeWhitelist(
  globalWhitelist: Partial<WhitelistPolicy> | undefined,
  repoWhitelist: Partial<WhitelistPolicy> | undefined,
): WhitelistPolicy {
  return {
    allowed_patterns: dedupeStrings([
      ...(globalWhitelist?.allowed_patterns ?? []),
      ...(repoWhitelist?.allowed_patterns ?? []),
    ]),
    denied_patterns: dedupeStrings([
      ...(globalWhitelist?.denied_patterns ?? []),
      ...(repoWhitelist?.denied_patterns ?? []),
    ]),
    advisory_level:
      repoWhitelist?.advisory_level
      ?? globalWhitelist?.advisory_level
      ?? "warn",
  };
}

function resolveToolPolicy(
  defaults: ContinuityDefaults,
  globalTool: ToolPolicyOverrides | undefined,
  repoTool: ToolPolicyOverrides | undefined,
): ToolContinuityPolicy {
  const categories = createDefaultCategoryMap(defaults.categories_enabled);
  applyCategoryOverrides(categories, globalTool?.categories);
  applyCategoryOverrides(categories, repoTool?.categories);

  return {
    enabled: repoTool?.enabled ?? globalTool?.enabled ?? defaults.sync_enabled,
    scope: repoTool?.scope ?? globalTool?.scope ?? defaults.scope,
    categories,
    preferences: {
      ...(globalTool?.preferences ?? {}),
      ...(repoTool?.preferences ?? {}),
    },
  };
}

function createDefaultCategoryMap(
  enabledCategories: ContinuityCategory[],
): Record<ContinuityCategory, boolean> {
  const enabled = new Set(enabledCategories);
  return {
    context_feed: enabled.has("context_feed"),
    skills: enabled.has("skills"),
    commands: enabled.has("commands"),
    agents: enabled.has("agents"),
    mcp_servers: enabled.has("mcp_servers"),
    slash_commands: enabled.has("slash_commands"),
    whitelist_policy: enabled.has("whitelist_policy"),
  };
}

function applyCategoryOverrides(
  target: Record<ContinuityCategory, boolean>,
  overrides: Partial<Record<ContinuityCategory, boolean>> | undefined,
): void {
  if (!overrides) {
    return;
  }

  for (const category of CONTINUITY_CATEGORIES) {
    if (typeof overrides[category] === "boolean") {
      target[category] = overrides[category];
    }
  }
}

function parseCategoryMap(
  input: unknown,
  path: string,
  errors: string[],
): Partial<Record<ContinuityCategory, boolean>> {
  if (!isRecord(input)) {
    errors.push(`${path}: expected object`);
    return {};
  }

  const result: Partial<Record<ContinuityCategory, boolean>> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isCategory(key)) {
      errors.push(`${path}.${key}: unknown category`);
      continue;
    }

    if (typeof value !== "boolean") {
      errors.push(`${path}.${key}: expected boolean`);
      continue;
    }

    result[key] = value;
  }

  return result;
}

function parseCategoryList(
  input: unknown,
  path: string,
  errors: string[],
): ContinuityCategory[] {
  if (!Array.isArray(input)) {
    errors.push(`${path}: expected array`);
    return [];
  }

  const parsed: ContinuityCategory[] = [];
  for (const item of input) {
    if (!isCategory(item)) {
      errors.push(`${path}: invalid category '${String(item)}'`);
      continue;
    }

    parsed.push(item);
  }

  return dedupeCategories(parsed);
}

function parseStringList(input: unknown, path: string, errors: string[]): string[] {
  if (!Array.isArray(input)) {
    errors.push(`${path}: expected array`);
    return [];
  }

  const result: string[] = [];
  for (const item of input) {
    if (typeof item !== "string" || item.trim().length === 0) {
      errors.push(`${path}: expected non-empty strings`);
      continue;
    }

    result.push(item.trim());
  }

  return dedupeStrings(result);
}

function dedupeCategories(values: ContinuityCategory[]): ContinuityCategory[] {
  return dedupeStrings(values) as ContinuityCategory[];
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    deduped.push(value);
  }

  return deduped;
}

function rejectUnknownKeys(
  source: Record<string, unknown>,
  allowedKeys: Set<string>,
  path: string,
  errors: string[],
): void {
  for (const key of Object.keys(source)) {
    if (!allowedKeys.has(key)) {
      errors.push(`${path}.${key}: unknown key`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isCategory(value: unknown): value is ContinuityCategory {
  return typeof value === "string" && CONTINUITY_CATEGORIES.includes(value as ContinuityCategory);
}

function isScope(value: unknown): value is ContinuityScope {
  return typeof value === "string" && CONTINUITY_SCOPES.includes(value as ContinuityScope);
}

function isAdvisoryLevel(value: unknown): value is AdvisoryLevel {
  return typeof value === "string" && ADVISORY_LEVELS.includes(value as AdvisoryLevel);
}

function isFileMissingError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return code === "ENOENT";
}

function createEmptyLayer(): ContinuityPolicyLayer {
  return {
    defaults: {},
    tools: {},
    policy: { whitelist: {} },
  };
}

function normalizeLayerForWrite(layer: ContinuityPolicyLayer): Record<string, unknown> {
  return {
    defaults: normalizeDefaultsForWrite(layer.defaults),
    tools: normalizeToolsForWrite(layer.tools),
    policy: {
      whitelist: normalizeWhitelistForWrite(layer.policy.whitelist),
    },
  };
}

function normalizeDefaultsForWrite(defaults: Partial<ContinuityDefaults>): Record<string, unknown> {
  const categories = defaults.categories_enabled
    ? dedupeCategories(defaults.categories_enabled)
    : undefined;

  return {
    sync_enabled: defaults.sync_enabled ?? true,
    categories_enabled: categories ?? [...CONTINUITY_CATEGORIES],
    scope: defaults.scope ?? "project",
  };
}

function normalizeToolsForWrite(
  tools: Record<string, ToolPolicyOverrides>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [tool, config] of Object.entries(tools)) {
    const normalizedCategories: Record<string, boolean> = {};
    for (const category of CONTINUITY_CATEGORIES) {
      const value = config.categories?.[category];
      if (typeof value === "boolean") {
        normalizedCategories[category] = value;
      }
    }

    output[tool] = {
      enabled: config.enabled ?? true,
      scope: config.scope ?? "project",
      categories: normalizedCategories,
      preferences: config.preferences ?? {},
    };
  }

  return output;
}

function normalizeWhitelistForWrite(
  whitelist: Partial<WhitelistPolicy>,
): Record<string, unknown> {
  return {
    allowed_patterns: dedupeStrings(whitelist.allowed_patterns ?? []),
    denied_patterns: dedupeStrings(whitelist.denied_patterns ?? []),
    advisory_level: whitelist.advisory_level ?? "warn",
  };
}
