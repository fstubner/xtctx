import { stringify as stringifyYaml } from "yaml";
import type { SharedToolConfig } from "../loader.js";

export function renderCopilotInstructions(config: SharedToolConfig): string {
  const lines: string[] = [
    "## xtctx Shared Context",
    "",
    "Use these shared project conventions before proposing changes.",
    "",
    "### Commands To Run",
    ...formatMarkdownList(config.shared.commands),
    "",
    "### Skills",
    ...formatMarkdownList(config.shared.skills),
    "",
    "### Agents",
    ...formatMarkdownList(config.shared.agents),
  ];

  const preferences = config.toolPreferences.copilot;
  if (preferences && Object.keys(preferences).length > 0) {
    lines.push("");
    lines.push("### Tool Preferences (`copilot`)");
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
