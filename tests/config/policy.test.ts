import { describe, expect, it } from "vitest";
import {
  CONTINUITY_CATEGORIES,
  ContinuityPolicyValidationError,
  mergeContinuityPolicyLayers,
  parseContinuityPolicySource,
  resolveToolFromPolicy,
} from "@xtctx/config/policy";

describe("continuity policy schema and merge", () => {
  it("enables default categories for registered tools with no overrides", () => {
    const resolved = mergeContinuityPolicyLayers(null, null, {
      registeredTools: ["claude", "codex"],
    });

    const codex = resolveToolFromPolicy(resolved, "codex");
    expect(codex.enabled).toBe(true);
    expect(codex.scope).toBe("project");

    for (const category of CONTINUITY_CATEGORIES) {
      expect(codex.categories[category]).toBe(true);
    }
  });

  it("applies repo overrides over global defaults and tool settings", () => {
    const globalLayer = parseContinuityPolicySource({
      defaults: {
        sync_enabled: false,
        scope: "global",
        categories_enabled: ["skills", "commands"],
      },
      tools: {
        codex: {
          enabled: true,
          scope: "hybrid",
          categories: {
            agents: true,
            commands: false,
          },
          preferences: {
            beforeStart: "xtctx_search",
            verbosity: "normal",
          },
        },
      },
      policy: {
        whitelist: {
          allowed_patterns: ["git status", "npm test"],
          denied_patterns: ["rm -rf *"],
          advisory_level: "warn",
        },
      },
    }, "global");

    const repoLayer = parseContinuityPolicySource({
      defaults: {
        sync_enabled: true,
        scope: "project",
        categories_enabled: ["context_feed", "skills", "commands"],
      },
      tools: {
        codex: {
          scope: "project",
          categories: {
            commands: true,
            mcp_servers: false,
          },
          preferences: {
            verbosity: "low",
          },
        },
      },
      policy: {
        whitelist: {
          allowed_patterns: ["npm test", "npm run build"],
          denied_patterns: ["curl http://localhost:*/admin"],
          advisory_level: "strict-hint",
        },
      },
    }, "repo");

    const resolved = mergeContinuityPolicyLayers(globalLayer, repoLayer, {
      registeredTools: ["codex"],
    });
    const codex = resolved.tools.codex;

    expect(codex.enabled).toBe(true);
    expect(codex.scope).toBe("project");
    expect(codex.categories.context_feed).toBe(true);
    expect(codex.categories.skills).toBe(true);
    expect(codex.categories.commands).toBe(true);
    expect(codex.categories.agents).toBe(true);
    expect(codex.categories.mcp_servers).toBe(false);
    expect(codex.preferences).toEqual({
      beforeStart: "xtctx_search",
      verbosity: "low",
    });

    expect(resolved.policy.whitelist.allowed_patterns).toEqual([
      "git status",
      "npm test",
      "npm run build",
    ]);
    expect(resolved.policy.whitelist.denied_patterns).toEqual([
      "rm -rf *",
      "curl http://localhost:*/admin",
    ]);
    expect(resolved.policy.whitelist.advisory_level).toBe("strict-hint");
  });

  it("rejects unknown keys in policy documents", () => {
    expect(() =>
      parseContinuityPolicySource({
        defaults: {
          sync_enabled: true,
          unexpected: true,
        },
      }, "repo"),
    ).toThrow(ContinuityPolicyValidationError);
  });

  it("rejects invalid categories and tool keys", () => {
    expect(() =>
      parseContinuityPolicySource({
        defaults: {
          categories_enabled: ["skills", "invalid_category"],
        },
        tools: {
          codex: {
            categories: {
              skills: true,
              invalid_category: true,
            },
            unknown: true,
          },
        },
      }, "repo"),
    ).toThrow(ContinuityPolicyValidationError);
  });
});
