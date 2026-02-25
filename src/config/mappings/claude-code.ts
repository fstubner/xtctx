import { stringify as stringifyYaml } from "yaml";
import type { SharedToolConfig } from "../loader.js";

export function renderClaudeConfig(config: SharedToolConfig): string {
  const lines: string[] = [
    "## xtctx Shared Context",
    "",
    "### Skills",
    ...formatMarkdownList(config.shared.skills),
    "",
    "### Commands",
    ...formatMarkdownList(config.shared.commands),
    "",
    "### Agents",
    ...formatMarkdownList(config.shared.agents),
  ];

  const preferences = config.toolPreferences["claude-code"];
  if (preferences && Object.keys(preferences).length > 0) {
    lines.push("");
    lines.push("### Tool Preferences (`claude-code`)");
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
