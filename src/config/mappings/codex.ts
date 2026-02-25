import { stringify as stringifyYaml } from "yaml";
import type { SharedToolConfig } from "../loader.js";

export function renderCodexConfig(config: SharedToolConfig): string {
  const lines: string[] = [
    "## xtctx Shared Context",
    "",
    "### Agents",
    ...formatMarkdownList(config.shared.agents),
    "",
    "### Skills",
    ...formatMarkdownList(config.shared.skills),
    "",
    "### Commands",
    ...formatMarkdownList(config.shared.commands),
  ];

  const preferences = config.toolPreferences.codex;
  if (preferences && Object.keys(preferences).length > 0) {
    lines.push("");
    lines.push("### Tool Preferences (`codex`)");
    lines.push("```yaml");
    lines.push(stringifyYaml(preferences).trimEnd());
    lines.push("```");
  }

  return lines.join("\n").trimEnd();
}

function formatMarkdownList(values: string[]): string[] {
  if (values.length === 0) {
    return ["- none"];
  }

  return values.map((value) => `- ${value}`);
}
