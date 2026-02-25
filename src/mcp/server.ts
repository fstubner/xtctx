import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export function buildToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "xtctx_search",
      description:
        "Search across all indexed context (conversations, code changes, knowledge). " +
        "Supports hybrid (semantic + keyword), semantic-only, or keyword-only modes. " +
        "Start with depth 'summary' and drill deeper if needed.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query" },
          mode: {
            type: "string",
            enum: ["hybrid", "semantic", "keyword"],
            description: "Search mode. Default: hybrid",
          },
          depth: {
            type: "string",
            enum: ["summary", "detail", "raw"],
            description: "Result depth. Start with summary. Default: summary",
          },
          source_filter: {
            type: "array",
            items: { type: "string" },
            description: "Filter by source tool, e.g. ['claude-code', 'cursor']",
          },
          type_filter: {
            type: "array",
            items: { type: "string" },
            description: "Filter by type: decision, error_solution, insight",
          },
          time_range: {
            type: "object",
            properties: {
              after: { type: "string", description: "ISO 8601 date" },
              before: { type: "string", description: "ISO 8601 date" },
            },
          },
          format: {
            type: "string",
            enum: ["markdown", "json"],
            description: "Response format. Default: markdown",
          },
          limit: {
            type: "number",
            description: "Max results. Default: 10",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "xtctx_recent_sessions",
      description:
        "CALL THIS FIRST when starting any session. Returns recent work " +
        "across all AI tools so you can continue where the last session left off.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max sessions. Default: 3" },
          tool_filter: {
            type: "array",
            items: { type: "string" },
            description: "Filter by tool name",
          },
        },
      },
    },
    {
      name: "xtctx_session_detail",
      description: "Drill into a specific session's raw conversation data.",
      inputSchema: {
        type: "object",
        properties: {
          session_ref: { type: "string", description: "Session reference from search results" },
          offset: { type: "number", description: "Message offset for pagination" },
          limit: { type: "number", description: "Max messages to return" },
        },
        required: ["session_ref"],
      },
    },
    {
      name: "xtctx_project_knowledge",
      description:
        "Get shared project knowledge (architectural decisions, error solutions, insights).",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["decision", "error_solution", "insight", "all"],
            description: "Filter by type. Default: all",
          },
          query: { type: "string", description: "Optional semantic filter" },
        },
      },
    },
    {
      name: "xtctx_save_decision",
      description:
        "Record an architectural or design decision with rationale. " +
        "Auto-enriched with file refs, domain tags, and version context. " +
        "Deduplication prevents near-duplicate entries.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short decision title" },
          rationale: { type: "string", description: "Why this was decided" },
          context: { type: "string", description: "What led to this decision" },
          alternatives_considered: {
            type: "array",
            items: { type: "string" },
            description: "Other options that were considered",
          },
        },
        required: ["title", "rationale"],
      },
    },
    {
      name: "xtctx_save_error_solution",
      description:
        "Record an error and its solution for future reference. " +
        "Auto-enriched with environment versions and domain tags.",
      inputSchema: {
        type: "object",
        properties: {
          error: { type: "string", description: "The error message or pattern" },
          solution: { type: "string", description: "What fixed it" },
          context: { type: "string", description: "When/why this occurs" },
        },
        required: ["error", "solution"],
      },
    },
    {
      name: "xtctx_save_insight",
      description:
        "Record a project insight, convention, or gotcha. " +
        "Use for things a future session should know.",
      inputSchema: {
        type: "object",
        properties: {
          insight: { type: "string", description: "The insight" },
          context: { type: "string", description: "Supporting context" },
        },
        required: ["insight"],
      },
    },
    {
      name: "xtctx_list_configs",
      description: "List available portable skills, commands, and agent definitions.",
      inputSchema: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["skill", "command", "agent", "all"],
            description: "Filter by config type. Default: all",
          },
        },
      },
    },
    {
      name: "xtctx_get_config",
      description: "Get a specific skill, command, or agent definition.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["skill", "command", "agent"] },
          name: { type: "string", description: "Config name" },
        },
        required: ["type", "name"],
      },
    },
    {
      name: "xtctx_tool_preferences",
      description: "Get tool-specific preferences and settings from cross-tool config.",
      inputSchema: {
        type: "object",
        properties: {
          tool: { type: "string", description: "Tool name, e.g. claude-code" },
        },
        required: ["tool"],
      },
    },
  ];
}

export async function startMcpServer(): Promise<void> {
  const server = new Server(
    { name: "xtctx", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  const tools = buildToolDefinitions();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools as any,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};

    return {
      content: [
        {
          type: "text",
          text: `Tool ${name} called with ${JSON.stringify(args)}`,
        },
      ],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
