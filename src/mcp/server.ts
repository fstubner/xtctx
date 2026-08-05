import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { createContinuityStatusHandler } from "./tools/continuity.js";
import { createHandoffManifestHandler } from "./tools/manifest.js";
import {
  createRecentSessionsHandler,
  createSearchSessionsHandler,
  createSessionDetailHandler,
  type SessionService,
} from "./tools/sessions.js";
import { errorMessage } from "../utils/errors.js";
import { readXtctxPackage } from "../utils/package-info.js";

const { version: SERVER_VERSION } = readXtctxPackage(import.meta.url);

type ToolParams = Record<string, unknown>;
type ToolHandler = (params: ToolParams) => Promise<unknown>;

export interface McpToolDependencies {
  sessions?: SessionService;
}

export function buildToolDefinitions(): Tool[] {
  return [
    {
      name: "xtctx_recent_sessions",
      description:
        "List recent local transcript sessions for this project. Call this first when you need cross-tool handoff context.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max sessions. Default: 5" },
          tool_filter: {
            type: "array",
            items: { type: "string" },
            description: "Optional tool ids to include",
          },
          format: {
            type: "string",
            enum: ["markdown", "json"],
            description: "Response format. Default: markdown",
          },
        },
      },
    },
    {
      name: "xtctx_session_detail",
      description: "Return raw messages from a session_ref returned by xtctx_recent_sessions or xtctx_search_sessions.",
      inputSchema: {
        type: "object",
        properties: {
          session_ref: { type: "string", description: "Session reference, e.g. codex:abc123" },
          offset: { type: "number", description: "Message offset for pagination" },
          limit: { type: "number", description: "Max messages to return. Default: 50" },
          format: {
            type: "string",
            enum: ["markdown", "json"],
            description: "Response format. Default: markdown",
          },
        },
        required: ["session_ref"],
      },
    },
    {
      name: "xtctx_search_sessions",
      description:
        "Hybrid semantic/keyword search over chronological transcript windows and return matching sessions.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language or keyword query" },
          limit: { type: "number", description: "Max sessions. Default: 5" },
          tool_filter: {
            type: "array",
            items: { type: "string" },
            description: "Optional tool ids to include",
          },
          mode: {
            type: "string",
            enum: ["hybrid", "keyword", "vector"],
            description: "Retrieval mode. Default: hybrid",
          },
          format: {
            type: "string",
            enum: ["markdown", "json"],
            description: "Response format. Default: markdown",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "xtctx_continuity_status",
      description: "Return xtctx handoff wiring and local index diagnostics.",
      inputSchema: {
        type: "object",
        properties: {
          format: {
            type: "string",
            enum: ["markdown", "json"],
            description: "Response format. Default: markdown",
          },
        },
      },
    },
    {
      name: "xtctx_handoff_manifest",
      description:
        "Return a read-only handoff manifest with stable session references and raw-detail retrieval pointers for an external orchestrator.",
      inputSchema: {
        type: "object",
        properties: {
          session_refs: {
            type: "array",
            items: { type: "string" },
            description: "Optional session refs to include. Defaults to recent sessions.",
          },
          tool_filter: {
            type: "array",
            items: { type: "string" },
            description: "Optional tool ids to include",
          },
          limit: { type: "number", description: "Max recent sessions. Default: 5" },
          correlation_id: {
            type: "string",
            description: "Optional caller-owned ID echoed in the response and never persisted by xtctx.",
          },
          format: {
            type: "string",
            enum: ["markdown", "json"],
            description: "Response format. Default: json",
          },
        },
      },
    },
  ];
}

export function createToolHandlers(
  dependencies: McpToolDependencies = {},
): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  if (dependencies.sessions) {
    handlers.set("xtctx_recent_sessions", createRecentSessionsHandler(dependencies.sessions));
    handlers.set("xtctx_session_detail", createSessionDetailHandler(dependencies.sessions));
    handlers.set("xtctx_search_sessions", createSearchSessionsHandler(dependencies.sessions));
    handlers.set("xtctx_continuity_status", createContinuityStatusHandler(dependencies.sessions));
    handlers.set("xtctx_handoff_manifest", createHandoffManifestHandler(dependencies.sessions));
  } else {
    const missing = missingDependency("session service");
    handlers.set("xtctx_recent_sessions", missing);
    handlers.set("xtctx_session_detail", missing);
    handlers.set("xtctx_search_sessions", missing);
    handlers.set("xtctx_continuity_status", missing);
    handlers.set("xtctx_handoff_manifest", missing);
  }

  return handlers;
}

export function createMcpServer(dependencies: McpToolDependencies = {}): Server {
  const server = new Server(
    { name: "xtctx", version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  const tools = buildToolDefinitions();
  const handlers = createToolHandlers(dependencies);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

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

export async function startMcpServer(dependencies: McpToolDependencies = {}): Promise<void> {
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
