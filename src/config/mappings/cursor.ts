import { stringify as stringifyYaml } from "yaml";
import type { SharedToolConfig } from "../loader.js";

export function renderCursorRules(config: SharedToolConfig): string {
  const lines: string[] = [
    "xtctx shared configuration",
    "",
    "Skills:",
    ...formatList(config.shared.skills),
    "",
    "Commands:",
    ...formatList(config.shared.commands),
    "",
    "Agents:",
    ...formatList(config.shared.agents),
  ];

  const preferences = config.toolPreferences.cursor;
  if (preferences && Object.keys(preferences).length > 0) {
    lines.push("");
    lines.push("Cursor Preferences:");
    lines.push(stringifyYaml(preferences).trimEnd());
  }

  return lines.join("\n").trimEnd();
}

function formatList(values: string[]): string[] {
  if (values.length === 0) {
    return ["- none"];
  }

  return values.map((value) => `- ${value}`);
}
