import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createGetConfigHandler,
  createListConfigsHandler,
  createToolPreferencesHandler,
  type ConfigStore,
} from "./tools/config.js";
import {
  createProjectKnowledgeHandler,
  type KnowledgeStore,
} from "./tools/knowledge.js";
import { createSearchHandler, type SearchRunner } from "./tools/search.js";
import {
  createRecentSessionsHandler,
  createSessionDetailHandler,
  type SessionService,
} from "./tools/sessions.js";
import {
  createWriteHandlers,
  type KnowledgeWriter,
  type SimilarityLookup,
} from "./tools/write.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

type ToolParams = Record<string, unknown>;
type ToolHandler = (params: ToolParams) => Promise<unknown>;

export interface McpToolDependencies {
  search?: SearchRunner;
  sessions?: SessionService;
  knowledge?: KnowledgeStore;
  writer?: KnowledgeWriter;
  findSimilar?: SimilarityLookup;
  configs?: ConfigStore;
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

export function createToolHandlers(
  dependencies: McpToolDependencies = {},
): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  if (dependencies.search) {
    const search = createSearchHandler(dependencies.search);
    handlers.set("xtctx_search", (params) => search(params as any));
  } else {
    handlers.set("xtctx_search", missingDependency("search index"));
  }

  if (dependencies.sessions) {
    const recentSessions = createRecentSessionsHandler(dependencies.sessions);
    const sessionDetail = createSessionDetailHandler(dependencies.sessions);
    handlers.set("xtctx_recent_sessions", (params) => recentSessions(params as any));
    handlers.set("xtctx_session_detail", (params) => sessionDetail(params as any));
  } else {
    handlers.set("xtctx_recent_sessions", missingDependency("session service"));
    handlers.set("xtctx_session_detail", missingDependency("session service"));
  }

  if (dependencies.knowledge) {
    const projectKnowledge = createProjectKnowledgeHandler(dependencies.knowledge);
    handlers.set("xtctx_project_knowledge", (params) => projectKnowledge(params as any));
  } else {
    handlers.set("xtctx_project_knowledge", missingDependency("knowledge store"));
  }

  if (dependencies.writer) {
    const writeHandlers = createWriteHandlers(dependencies.writer, dependencies.findSimilar);
    handlers.set("xtctx_save_decision", (params) => writeHandlers.saveDecision(params as any));
    handlers.set("xtctx_save_error_solution", (params) =>
      writeHandlers.saveErrorSolution(params as any),
    );
    handlers.set("xtctx_save_insight", (params) => writeHandlers.saveInsight(params as any));
  } else {
    handlers.set("xtctx_save_decision", missingDependency("knowledge writer"));
    handlers.set("xtctx_save_error_solution", missingDependency("knowledge writer"));
    handlers.set("xtctx_save_insight", missingDependency("knowledge writer"));
  }

  if (dependencies.configs) {
    const listConfigs = createListConfigsHandler(dependencies.configs);
    const getConfig = createGetConfigHandler(dependencies.configs);
    const toolPreferences = createToolPreferencesHandler(dependencies.configs);
    handlers.set("xtctx_list_configs", (params) => listConfigs(params as any));
    handlers.set("xtctx_get_config", (params) => getConfig(params as any));
    handlers.set("xtctx_tool_preferences", (params) => toolPreferences(params as any));
  } else {
    handlers.set("xtctx_list_configs", missingDependency("config store"));
    handlers.set("xtctx_get_config", missingDependency("config store"));
    handlers.set("xtctx_tool_preferences", missingDependency("config store"));
  }

  return handlers;
}

export function createMcpServer(
  dependencies: McpToolDependencies = {},
): Server {
  const server = new Server(
    { name: "xtctx", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  const tools = buildToolDefinitions();
  const handlers = createToolHandlers(dependencies);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools as any,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const params = asToolParams(request.params.arguments);
    const handler = handlers.get(name);

    if (!handler) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
    }

    try {
      const result = await handler(params);
      return formatCallToolResult(result);
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Tool ${name} failed: ${errorMessage(error)}` }],
      };
    }
  });

  return server;
}

export async function startMcpServer(
  dependencies: McpToolDependencies = {},
): Promise<void> {
  const server = createMcpServer(dependencies);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function asToolParams(value: unknown): ToolParams {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as ToolParams;
  }

  return {};
}

function missingDependency(dependency: string): ToolHandler {
  return async () => ({
    error: `Tool is unavailable because ${dependency} is not configured.`,
  });
}

function formatCallToolResult(result: unknown): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
} {
  const response: {
    content: Array<{ type: "text"; text: string }>;
    structuredContent?: Record<string, unknown>;
  } = {
    content: [
      {
        type: "text",
        text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
      },
    ],
  };

  if (result && typeof result === "object" && !Array.isArray(result)) {
    response.structuredContent = result as Record<string, unknown>;
  }

  return response;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
