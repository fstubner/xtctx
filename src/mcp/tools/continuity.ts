import type { EffectiveContinuityPolicy } from "../../config/policy.js";
import type { ToolContinuityStatus } from "../../config/sync.js";

export interface ContinuityReader {
  effectivePolicy(): Promise<EffectiveContinuityPolicy>;
  toolStatuses(): Promise<ToolContinuityStatus[]>;
}

interface ContinuityStatusParams {
  tool_filter?: string[];
  format?: "markdown" | "json";
}

interface EffectivePolicyParams {
  format?: "markdown" | "json";
}

export function createContinuityStatusHandler(reader: ContinuityReader) {
  return async (raw: Record<string, unknown> = {}) => {
    const params = raw as unknown as ContinuityStatusParams;
    const format = params.format ?? "markdown";
    const filter = new Set(
      (params.tool_filter ?? []).filter((value): value is string => typeof value === "string"),
    );

    const statuses = await reader.toolStatuses();
    const filtered = filter.size > 0
      ? statuses.filter((status) => filter.has(status.tool))
      : statuses;

    if (format === "json") {
      return { tools: filtered };
    }

    if (filtered.length === 0) {
      return "No continuity tool statuses found.";
    }

    const lines = ["## Continuity Status\n"];
    for (const tool of filtered) {
      lines.push(`### ${tool.tool}`);
      lines.push(`- state: ${tool.state}`);
      lines.push(`- scope: ${tool.scope}`);
      lines.push(`- enabled: ${tool.enabled}`);
      lines.push(`- categories: ${enabledCategoryList(tool)}`);
      lines.push(`- targets: ${tool.targets.map((target) => target.path).join(", ") || "none"}`);
      if (tool.warnings.length > 0) {
        lines.push("- warnings:");
        for (const warning of tool.warnings) {
          lines.push(`  - ${warning}`);
        }
      }
      lines.push("");
    }

    return lines.join("\n").trimEnd();
  };
}

export function createEffectivePolicyHandler(reader: ContinuityReader) {
  return async (raw: Record<string, unknown> = {}) => {
    const params = raw as unknown as EffectivePolicyParams;
    const format = params.format ?? "markdown";
    const policy = await reader.effectivePolicy();

    if (format === "json") {
      return policy;
    }

    const lines = [
      "## Effective Continuity Policy",
      "",
      `- resolved_at: ${policy.resolved_at}`,
      `- defaults.sync_enabled: ${policy.defaults.sync_enabled}`,
      `- defaults.scope: ${policy.defaults.scope}`,
      `- defaults.categories: ${policy.defaults.categories_enabled.join(", ") || "none"}`,
      `- whitelist.allowed: ${policy.policy.whitelist.allowed_patterns.length}`,
      `- whitelist.denied: ${policy.policy.whitelist.denied_patterns.length}`,
      `- whitelist.advisory: ${policy.policy.whitelist.advisory_level}`,
      "",
      "### Source layers",
      ...policy.source_layers.map((layer) =>
        `- ${layer.layer}: ${layer.loaded ? "loaded" : "not found"} (${layer.path})`
      ),
      "",
      "### Tools",
      ...Object.entries(policy.tools).map(([tool, value]) =>
        `- ${tool}: ${value.enabled ? "enabled" : "disabled"} (${value.scope})`
      ),
    ];

    return lines.join("\n");
  };
}

function enabledCategoryList(status: ToolContinuityStatus): string {
  const categories = Object.entries(status.categories)
    .filter(([, enabled]) => enabled)
    .map(([category]) => category);
  return categories.join(", ") || "none";
}
