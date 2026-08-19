import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { setupProject } from "../dist/src/config/setup.js";
// Import the real encoder rather than reimplementing it: this script kept its
// own copy, which still stripped the leading separator dash after the product
// stopped doing so. The synthetic store it built then no longer matched what
// the scraper looks for, so the demo failed on macOS and Linux — and would
// have passed while shipping a store layout no real POSIX install produces.
import { encodePathForToolDirectory } from "../dist/src/utils/project-scope.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const cliPath = join(repoRoot, "dist", "src", "cli", "index.js");

await assertBuilt();

const tempRoot = await mkdtemp(join(tmpdir(), "xtctx-public-demo-"));
const projectRoot = join(tempRoot, "project");
const homeDir = join(tempRoot, "home");
const claudeStore = join(tempRoot, "stores", "claude-code");
const codexStore = join(tempRoot, "stores", "codex");
const keepTemp = process.env.XTCTX_DEMO_KEEP === "1";

try {
  await mkdir(projectRoot, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await writeSyntheticTranscripts();
  await setupProject({ projectPath: projectRoot, homeDir, yes: true });
  await pointConfigAtSyntheticStores();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath],
    cwd: projectRoot,
  });
  const client = new Client(
    { name: "xtctx-public-demo", version: "0.0.0" },
    { capabilities: {} },
  );

  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    assertDeepEqual(toolNames, [
      "xtctx_continuity_status",
      "xtctx_handoff_manifest",
      "xtctx_recent_sessions",
      "xtctx_search_sessions",
      "xtctx_session_detail",
    ]);

    const recent = await callJson(client, "xtctx_recent_sessions", {
      limit: 5,
      format: "json",
    });
    assert(recent.sessions.length === 2, "expected two synthetic sessions");

    const search = await callJson(client, "xtctx_search_sessions", {
      query: "synthetic public demo",
      mode: "keyword",
      limit: 3,
      format: "json",
    });
    const codexMatch = search.sessions.find(
      (session) => session.session_ref === "codex:demo-codex-session",
    );
    assert(codexMatch, "expected keyword search to find the synthetic Codex session");

    // Exercise the embedding path too. Pinning this to keyword let a broken
    // pipeline — which threw on every embed call and silently degraded hybrid
    // to keyword-only — pass the whole release gate.
    const vectorSearch = await callJson(client, "xtctx_search_sessions", {
      query: "synthetic public demo",
      mode: "vector",
      limit: 3,
      format: "json",
    });
    assert(
      vectorSearch.sessions.length > 0,
      "expected semantic search to return a session (embedding pipeline broken?)",
    );

    const vectorStatus = await callJson(client, "xtctx_continuity_status", { format: "json" });
    assert(
      !vectorStatus.embedding_error,
      `expected no embedding error, got: ${vectorStatus.embedding_error}`,
    );
    assert(
      vectorStatus.vectorized_units > 0,
      "expected the demo to produce vectorized retrieval windows",
    );

    const detail = await callJson(client, "xtctx_session_detail", {
      session_ref: "codex:demo-codex-session",
      offset: 0,
      limit: 10,
      format: "json",
    });
    assert(detail.messages.length === 2, "expected two Codex detail messages");
    assert(
      detail.messages.some((message) => message.content.includes("synthetic public demo")),
      "expected session detail to include the synthetic demo message",
    );

    const status = await callJson(client, "xtctx_continuity_status", {
      format: "json",
    });
    assert(status.sessions === 2, `expected 2 indexed sessions, got ${status.sessions}`);
    assert(status.messages === 4, `expected 4 indexed messages, got ${status.messages}`);
    assert(status.retrieval_units === 2, "expected one retrieval window per synthetic session");

    console.log("xtctx public demo smoke passed");
    console.log(`tools: ${toolNames.join(", ")}`);
    console.log(`sessions: ${status.sessions}, messages: ${status.messages}`);
    console.log(`search match: ${codexMatch.session_ref}`);
    console.log("data: synthetic temp transcripts only");
  } finally {
    await client.close();
  }
} finally {
  if (keepTemp) {
    console.log(`kept temp project: ${projectRoot}`);
  } else {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function assertBuilt() {
  try {
    await readFile(cliPath, "utf-8");
  } catch {
    throw new Error("Build output is missing. Run `npm run build` before `npm run demo:public`.");
  }
}

async function writeSyntheticTranscripts() {
  const claudeProjectDir = join(claudeStore, encodePathForToolDirectory(projectRoot));
  await mkdir(claudeProjectDir, { recursive: true });
  await writeFile(
    join(claudeProjectDir, "demo-claude-session.jsonl"),
    [
      JSON.stringify({
        type: "user",
        timestamp: "2026-05-01T10:00:00.000Z",
        message: {
          role: "user",
          content: "Claude note: keep xtctx narrow, local, and honest.",
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-01T10:00:05.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "The public surface should mention setup, status, disconnect, and five MCP tools.",
            },
          ],
        },
      }),
    ].join("\n") + "\n",
    "utf-8",
  );

  await mkdir(join(codexStore, "2026", "05", "01"), { recursive: true });
  await writeFile(
    join(codexStore, "2026", "05", "01", "demo-codex-session.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-05-01T10:01:00.000Z",
        type: "session_meta",
        payload: {
          id: "demo-codex-session",
          timestamp: "2026-05-01T10:01:00.000Z",
          cwd: projectRoot,
          originator: "codex_cli_rs",
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-01T10:01:01.000Z",
        type: "turn_context",
        payload: {
          approval_policy: "suggest",
          sandbox_policy: { type: "workspace-write" },
          cwd: projectRoot,
          model: "demo-model",
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-01T10:01:02.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Codex follow-up: add a synthetic public demo that proves handoff without private transcript data.",
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-01T10:01:07.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Use fake transcript stores, keyword search, session detail, and continuity status.",
            },
          ],
        },
      }),
    ].join("\n") + "\n",
    "utf-8",
  );
}

async function pointConfigAtSyntheticStores() {
  const configPath = join(projectRoot, ".xtctx", "config.yaml");
  const config = parseYaml(await readFile(configPath, "utf-8"));
  assert(config && typeof config === "object", "expected generated xtctx config");

  const tools = config.tools ?? {};
  for (const [tool, value] of Object.entries(tools)) {
    tools[tool] = {
      ...(value && typeof value === "object" ? value : {}),
      enabled: false,
    };
  }

  tools["claude-code"] = {
    ...(tools["claude-code"] ?? {}),
    enabled: true,
    storePath: claudeStore,
  };
  tools.codex = {
    ...(tools.codex ?? {}),
    enabled: true,
    storePath: codexStore,
  };
  config.tools = tools;

  await writeFile(configPath, stringifyYaml(config), "utf-8");
}

async function callJson(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.structuredContent) {
    return result.structuredContent;
  }

  const text = result.content?.[0]?.text;
  return JSON.parse(text);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertDeepEqual(actual, expected) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assert(actualJson === expectedJson, `expected ${expectedJson}, got ${actualJson}`);
}
