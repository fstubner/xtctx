export type ConfigType = "skill" | "command" | "agent";

export interface NamedConfig {
  type: ConfigType;
  name: string;
  content: Record<string, unknown>;
}

export interface ConfigStore {
  list(type?: ConfigType): Promise<NamedConfig[]>;
  get(type: ConfigType, name: string): Promise<NamedConfig | null>;
  toolPreferences(tool: string): Promise<Record<string, unknown>>;
}

interface ListConfigsParams {
  type?: ConfigType | "all";
  format?: "markdown" | "json";
}

interface GetConfigParams {
  type: ConfigType;
  name: string;
  format?: "markdown" | "json";
}

interface ToolPreferencesParams {
  tool: string;
  format?: "markdown" | "json";
}

export function createListConfigsHandler(store: ConfigStore) {
  return async (params: ListConfigsParams = {}) => {
    const type = params.type ?? "all";
    const format = params.format ?? "markdown";
    const configs = type === "all" ? await store.list() : await store.list(type);

    if (format === "json") {
      return { type, count: configs.length, configs };
    }

    if (configs.length === 0) {
      return `No ${type} configs found.`;
    }

    const lines = [`## ${configs.length} ${type} config(s)\n`];
    for (const cfg of configs) {
      lines.push(`- ${cfg.type}: ${cfg.name}`);
    }
    return lines.join("\n");
  };
}

export function createGetConfigHandler(store: ConfigStore) {
  return async (params: GetConfigParams) => {
    const format = params.format ?? "markdown";
    const config = await store.get(params.type, params.name);

    if (!config) {
      return `Config not found: ${params.type}/${params.name}`;
    }

    if (format === "json") {
      return config;
    }

    return [
      `## ${config.type}: ${config.name}`,
      "",
      "```json",
      JSON.stringify(config.content, null, 2),
      "```",
    ].join("\n");
  };
}

export function createToolPreferencesHandler(store: ConfigStore) {
  return async (params: ToolPreferencesParams) => {
    const format = params.format ?? "markdown";
    const preferences = await store.toolPreferences(params.tool);

    if (format === "json") {
      return { tool: params.tool, preferences };
    }

    return [
      `## Preferences for ${params.tool}`,
      "",
      "```json",
      JSON.stringify(preferences, null, 2),
      "```",
    ].join("\n");
  };
}
