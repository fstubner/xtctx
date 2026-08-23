import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AntigravityScraper,
  parseAntigravityRuntimeSteps,
  HANDLED_STEP_TYPES,
  KNOWN_UNHANDLED_STEP_TYPES,
  listConversationFileIds,
  mapWithConcurrency,
  parsePosixListeningPorts,
  shouldFetchTrajectory,
  parseWindowsListeningPorts,
  type AntigravityRuntimeClient,
  type AntigravityRuntimeConversation,
} from "@xtctx/scrapers/antigravity";
import type { AntigravityChunk } from "@xtctx/types/scraper";

async function collect(scraper: AntigravityScraper): Promise<AntigravityChunk[]> {
  const chunks: AntigravityChunk[] = [];
  for await (const chunk of scraper.fullSync()) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("AntigravityScraper", () => {
  let rootDir = "";
  let stateDir = "";
  let projectRoot = "";

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "xtctx-antigravity-root-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-antigravity-state-"));
    projectRoot = join("H:", "projects", "private", "needs-work", "xtctx");
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it("does not report Antigravity as installed because xtctx wrote its MCP config", async () => {
    // `setup` writes ~/.gemini/antigravity/mcp_config.json unconditionally,
    // so counting that file as evidence made status flip from "not detected"
    // to "detected" purely as a side effect of running setup.
    await writeFile(join(rootDir, "mcp_config.json"), "{}", "utf-8");

    const scraper = new AntigravityScraper(rootDir, stateDir, projectRoot, emptyRuntimeClient());

    await expect(scraper.detect()).resolves.toBe(false);
  });

  it("detects Antigravity state when brain artifacts are present", async () => {
    await mkdir(join(rootDir, "brain"), { recursive: true });

    const scraper = new AntigravityScraper(rootDir, stateDir, projectRoot, emptyRuntimeClient());

    await expect(scraper.detect()).resolves.toBe(true);
    expect(scraper.getStorePaths()).toEqual([rootDir]);
  });

  it("reads readable brain artifacts as handoff chunks", async () => {
    const sessionDir = join(rootDir, "brain", "session-a");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "implementation_plan.md"),
      [
        "# Implementation Plan",
        "",
        "Modify [src/index.ts](file:///h%3A/projects/private/needs-work/xtctx/src/index.ts).",
      ].join("\n"),
      "utf-8",
    );
    await writeFile(
      join(sessionDir, "implementation_plan.md.metadata.json"),
      JSON.stringify({
        artifactType: "ARTIFACT_TYPE_IMPLEMENTATION_PLAN",
        summary: "Implement xtctx support.",
        updatedAt: "2026-05-10T12:00:00.000Z",
        version: "2",
      }),
      "utf-8",
    );
    await writeFile(join(sessionDir, "implementation_plan.md.resolved"), "duplicate", "utf-8");

    const chunks = await collect(new AntigravityScraper(rootDir, stateDir, projectRoot, emptyRuntimeClient()));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      tool: "antigravity",
      sessionId: "session-a",
      role: "assistant",
      timestamp: new Date("2026-05-10T12:00:00.000Z"),
    });
    expect(chunks[0].content).toContain("Antigravity artifact: implementation_plan.md");
    expect(chunks[0].content).toContain("Implement xtctx support.");
    expect(chunks[0].metadata).toMatchObject({
      messageIndex: 0,
      artifactType: "ARTIFACT_TYPE_IMPLEMENTATION_PLAN",
      artifactName: "implementation_plan.md",
      summary: "Implement xtctx support.",
    });
    expect(chunks[0].metadata.referencedFiles).toEqual([
      "h:/projects/private/needs-work/xtctx/src/index.ts",
    ]);
  });

  it("filters artifacts to the project root or Antigravity playground project", async () => {
    const matchedSessionDir = join(rootDir, "brain", "session-matched");
    const playgroundSessionDir = join(rootDir, "brain", "session-playground");
    const unrelatedSessionDir = join(rootDir, "brain", "session-unrelated");
    await mkdir(matchedSessionDir, { recursive: true });
    await mkdir(playgroundSessionDir, { recursive: true });
    await mkdir(unrelatedSessionDir, { recursive: true });

    await writeArtifact(
      matchedSessionDir,
      "task.md",
      "Use file:///h:/projects/private/needs-work/xtctx/src/cli/index.ts",
      "2026-05-10T12:00:00.000Z",
    );
    await writeArtifact(
      playgroundSessionDir,
      "task.md",
      "Use file:///c:/Users/Felix/.gemini/antigravity/playground/xtctx/src/cli/index.ts",
      "2026-05-10T12:01:00.000Z",
    );
    await writeArtifact(
      unrelatedSessionDir,
      "task.md",
      "Use file:///h:/projects/private/other/src/index.ts",
      "2026-05-10T12:02:00.000Z",
    );

    const chunks = await collect(new AntigravityScraper(rootDir, stateDir, projectRoot, emptyRuntimeClient()));

    expect(chunks.map((chunk) => chunk.sessionId).sort()).toEqual([
      "session-matched",
      "session-playground",
    ]);
  });

  it("supports incremental cutoff by artifact timestamp", async () => {
    const sessionDir = join(rootDir, "brain", "session-a");
    await mkdir(sessionDir, { recursive: true });
    await writeArtifact(
      sessionDir,
      "task.md",
      "Use file:///h:/projects/private/needs-work/xtctx/src/cli/index.ts",
      "2026-05-10T12:00:00.000Z",
    );
    await writeArtifact(
      sessionDir,
      "walkthrough.md",
      "Use file:///h:/projects/private/needs-work/xtctx/README.md",
      "2026-05-10T12:05:00.000Z",
    );

    const scraper = new AntigravityScraper(rootDir, stateDir, projectRoot, emptyRuntimeClient());
    const chunks: AntigravityChunk[] = [];
    for await (const chunk of scraper.scrape(new Date("2026-05-10T12:00:00.000Z"))) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(chunks[0].metadata.artifactName).toBe("walkthrough.md");
    expect(chunks[0].metadata.messageIndex).toBe(1);
  });

  it("prefers full runtime transcript steps when Antigravity language server data is available", async () => {
    const conversations: AntigravityRuntimeConversation[] = [
      {
        sessionId: "cascade-1",
        title: "Implement xtctx",
        createdAt: new Date("2026-05-10T12:00:00.000Z"),
        workspaces: ["file:///h:/projects/private/needs-work/xtctx"],
        messages: [
          {
            sessionId: "cascade-1",
            timestamp: new Date("2026-05-10T12:00:00.000Z"),
            role: "user",
            content: "Please update src/cli/index.ts",
            referencedFiles: ["h:/projects/private/needs-work/xtctx/src/cli/index.ts"],
            sourcePath: "file:///h:/projects/private/needs-work/xtctx/src/cli/index.ts",
            stepType: "CORTEX_STEP_TYPE_USER_INPUT",
          },
          {
            sessionId: "cascade-1",
            timestamp: new Date("2026-05-10T12:00:05.000Z"),
            role: "assistant",
            content: "I updated the CLI entrypoint.",
            referencedFiles: [],
            stepType: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
            model: "gemini-3-pro",
          },
          {
            sessionId: "cascade-1",
            timestamp: new Date("2026-05-10T12:00:10.000Z"),
            role: "tool",
            content: "[Command] npm test\nexit_code: 0\nOutput:\npassed",
            referencedFiles: [],
            stepType: "CORTEX_STEP_TYPE_RUN_COMMAND",
            toolName: "run_command",
          },
        ],
      },
    ];

    const sessionDir = join(rootDir, "brain", "artifact-fallback");
    await mkdir(sessionDir, { recursive: true });
    await writeArtifact(
      sessionDir,
      "task.md",
      "Use file:///h:/projects/private/needs-work/xtctx/README.md",
      "2026-05-10T12:05:00.000Z",
    );

    const chunks = await collect(new AntigravityScraper(
      rootDir,
      stateDir,
      projectRoot,
      runtimeClient(conversations),
    ));

    expect(chunks).toHaveLength(3);
    expect(chunks.map((chunk) => chunk.role)).toEqual(["user", "assistant", "tool"]);
    expect(chunks.map((chunk) => chunk.sessionId)).toEqual(["cascade-1", "cascade-1", "cascade-1"]);
    expect(chunks[0].metadata).toMatchObject({
      artifactType: "ANTIGRAVITY_LANGUAGE_SERVER_TRANSCRIPT",
      artifactName: "CORTEX_STEP_TYPE_USER_INPUT",
      sourcePath: "file:///h:/projects/private/needs-work/xtctx/src/cli/index.ts",
      summary: "Implement xtctx",
    });
    expect(chunks[1].metadata.model).toBe("gemini-3-pro");
    expect(chunks[2].metadata.toolName).toBe("run_command");
    expect(chunks.map((chunk) => chunk.sessionId)).not.toContain("artifact-fallback");
  });

  it("excludes runtime conversations whose only link to the project is its name", async () => {
    // Attribution must be path-based. Matching the project's directory name
    // anywhere in the text attributed *another* project's private
    // conversation to this one whenever it happened to mention the word —
    // observed live during an acceptance review. Fail closed instead.
    const chunks = await collect(new AntigravityScraper(
      rootDir,
      stateDir,
      projectRoot,
      runtimeClient([
        {
          sessionId: "cascade-summary-only",
          title: "Does xtctx support Antigravity?",
          workspaces: [],
          messages: [
            {
              sessionId: "cascade-summary-only",
              timestamp: new Date("2026-05-10T12:00:00.000Z"),
              role: "user",
              content: "Does xtctx support Antigravity?",
              referencedFiles: [],
              stepType: "CORTEX_STEP_TYPE_USER_INPUT",
            },
          ],
        },
      ]),
    ));

    expect(chunks).toHaveLength(0);
  });

  it("does not leak another project's conversation that mentions this project's name", async () => {
    const chunks = await collect(new AntigravityScraper(
      rootDir,
      stateDir,
      projectRoot,
      runtimeClient([
        {
          sessionId: "cascade-other-project",
          title: "work in the other repo",
          workspaces: ["file:///h:/projects/private/needs-work/other-thing"],
          messages: [
            {
              sessionId: "cascade-other-project",
              timestamp: new Date("2026-05-10T12:00:00.000Z"),
              role: "user",
              content: "port the xtctx approach over to this repo",
              referencedFiles: ["h:/projects/private/needs-work/other-thing/src/main.ts"],
              stepType: "CORTEX_STEP_TYPE_USER_INPUT",
            },
          ],
        },
      ]),
    ));

    expect(chunks).toHaveLength(0);
  });

  it("parses raw Antigravity language-server steps into user, assistant, and tool messages", () => {
    const messages = parseAntigravityRuntimeSteps(
      "cascade-raw",
      [
        {
          type: "CORTEX_STEP_TYPE_USER_INPUT",
          metadata: { createdAt: "2026-05-10T12:00:00.000Z" },
          userInput: {
            userResponse: "Change [index.ts](file:///h%3A/projects/private/needs-work/xtctx/src/index.ts)",
            activeUserState: {
              activeDocument: {
                absoluteUri: "file:///h:/projects/private/needs-work/xtctx/src/index.ts",
              },
            },
          },
        },
        {
          type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
          metadata: {
            createdAt: "2026-05-10T12:00:05.000Z",
            generatorModel: "gemini-3-pro",
          },
          plannerResponse: {
            response: "Updated the entrypoint.",
          },
        },
        {
          type: "CORTEX_STEP_TYPE_CODE_ACTION",
          metadata: { createdAt: "2026-05-10T12:00:10.000Z" },
          codeAction: {
            description: "Apply CLI change",
            actionResult: {
              edit: {
                absoluteUri: "file:///h:/projects/private/needs-work/xtctx/src/index.ts",
                diff: {
                  unifiedDiff: {
                    lines: [
                      { type: "UNIFIED_DIFF_LINE_TYPE_DELETE", text: "old" },
                      { type: "UNIFIED_DIFF_LINE_TYPE_INSERT", text: "new" },
                    ],
                  },
                },
              },
            },
          },
        },
        {
          type: "CORTEX_STEP_TYPE_RUN_COMMAND",
          metadata: { createdAt: "2026-05-10T12:00:15.000Z" },
          runCommand: {
            commandLine: "npm test",
            cwd: "H:/projects/private/needs-work/xtctx",
            exitCode: 0,
            combinedOutput: { full: "passed" },
          },
        },
      ],
      { summary: "Raw cascade", createdTime: "2026-05-10T11:59:00.000Z" },
    );

    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "tool"]);
    expect(messages[0].referencedFiles).toEqual([
      "h:/projects/private/needs-work/xtctx/src/index.ts",
    ]);
    expect(messages[1]).toMatchObject({
      content: "Updated the entrypoint.",
      model: "gemini-3-pro",
      stepType: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
    });
    expect(messages[2].content).toContain("Diff:\n-old\n+new");
    expect(messages[3]).toMatchObject({
      toolName: "run_command",
      content: "[Command] npm test\ncwd: H:/projects/private/needs-work/xtctx\nexit_code: 0\nOutput:\npassed",
    });
  });
});

function emptyRuntimeClient(): AntigravityRuntimeClient {
  return runtimeClient([]);
}

function runtimeClient(conversations: AntigravityRuntimeConversation[]): AntigravityRuntimeClient {
  return {
    async listConversations() {
      return conversations;
    },
  };
}

async function writeArtifact(
  sessionDir: string,
  name: string,
  body: string,
  updatedAt: string,
): Promise<void> {
  await writeFile(join(sessionDir, name), body, "utf-8");
  await writeFile(
    join(sessionDir, `${name}.metadata.json`),
    JSON.stringify({ artifactType: "ARTIFACT_TYPE_TASK", updatedAt }),
    "utf-8",
  );
}

describe("listening-port discovery", () => {
  // Real `netstat -ano` output shape. The PID is the last whitespace-
  // separated field, so a suffix match attributes another process's
  // listening ports to the language server — and the CSRF token is then
  // POSTed to whatever is on that port.
  const NETSTAT = [
    "Active Connections",
    "",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       2140",
    "  TCP    127.0.0.1:52001        0.0.0.0:0              LISTENING       140",
    "  TCP    127.0.0.1:52002        0.0.0.0:0              LISTENING       31140",
    "  TCP    127.0.0.1:52003        127.0.0.1:9000         ESTABLISHED     140",
  ].join("\r\n");

  it("matches the PID column exactly, not by suffix", () => {
    expect(parseWindowsListeningPorts(NETSTAT, 140)).toEqual([52001]);
  });

  it("ignores non-listening rows for the same PID", () => {
    expect(parseWindowsListeningPorts(NETSTAT, 140)).not.toContain(9000);
  });

  it("returns nothing for a PID that owns no listening socket", () => {
    expect(parseWindowsListeningPorts(NETSTAT, 999)).toEqual([]);
  });

  it("parses posix lsof output", () => {
    const lsof = [
      "COMMAND     PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "language_ 4242 felix   21u  IPv4 0x1234      0t0  TCP 127.0.0.1:52010 (LISTEN)",
    ].join("\n");
    expect(parsePosixListeningPorts(lsof)).toEqual([52010]);
  });
});

/**
 * Antigravity migrated its conversation store from protobuf `.pb` files to
 * SQLite `.db` files, keeping the cascade id as the file name. Enumeration
 * only looked for `.pb`, so every session written after the migration was
 * skipped — 117 of them on the machine where this was found, with no error:
 * the runtime simply was not asked about them.
 */
describe("listConversationFileIds", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "xtctx-agconv-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(...names: string[]): Promise<void> {
    for (const name of names) {
      await writeFile(join(dir, name), "", "utf-8");
    }
  }

  it("enumerates sessions from both the protobuf and SQLite stores", async () => {
    await write("aaa.pb", "bbb.db");

    expect((await listConversationFileIds(dir)).sort()).toEqual(["aaa", "bbb"]);
  });

  it("reports a session once when both stores hold it", async () => {
    await write("ccc.pb", "ccc.db");

    expect(await listConversationFileIds(dir)).toEqual(["ccc"]);
  });

  it("ignores files that are neither store", async () => {
    await write("notes.txt", "ddd.db");

    expect(await listConversationFileIds(dir)).toEqual(["ddd"]);
  });
});

/**
 * Fetching a trajectory pulls its whole transcript over the wire with a 30s
 * timeout. Doing that for all 155 sessions on this machine and filtering
 * afterwards meant most of the work — and most of the transcripts — belonged
 * to other projects.
 */
describe("shouldFetchTrajectory", () => {
  const projectRoot = "/home/dev/projects/xtctx";

  function summaryFor(...uris: string[]) {
    return { workspaces: uris.map((uri) => ({ workspaceFolderAbsoluteUri: uri })) };
  }

  it("fetches a trajectory whose workspace is this project", () => {
    expect(
      shouldFetchTrajectory(summaryFor("file:///home/dev/projects/xtctx"), projectRoot),
    ).toBe(true);
  });

  it("skips one whose workspace is a different project", () => {
    // Not just cheaper — that transcript is never pulled over the wire at all.
    expect(
      shouldFetchTrajectory(summaryFor("file:///home/dev/projects/netscli"), projectRoot),
    ).toBe(false);
  });

  it("fetches when no workspace is recorded, because that rules nothing out", () => {
    // The message bodies may carry the only path evidence there is, and on
    // this machine 83 of 155 summaries name no workspace.
    expect(shouldFetchTrajectory({ summary: "[on-disk] abc12345" }, projectRoot)).toBe(true);
  });

  it("fetches everything when the scraper is not scoped to a project", () => {
    expect(shouldFetchTrajectory(summaryFor("file:///somewhere/else"), undefined)).toBe(true);
  });
});

describe("mapWithConcurrency", () => {
  it("keeps results in input order regardless of completion order", async () => {
    const results = await mapWithConcurrency([30, 10, 20, 0], 3, async (delay: number) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return delay;
    });

    expect(results).toEqual([30, 10, 20, 0]);
  });

  it("keeps at most the requested number in flight", async () => {
    let running = 0;
    let peak = 0;

    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 4, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return null;
    });

    expect(peak).toBeLessThanOrEqual(4);
  });

  it("loses only the item that failed, not the rest of the scan", async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (value: number) => {
      if (value === 2) throw new Error("language server hung up");
      return value;
    });

    expect(results).toEqual([1, null, 3]);
  });
});

/**
 * Antigravity is the only reader that talks to a live language server, and it
 * was also the only one that could not report a format surprise at all — a
 * renamed step type would have dropped messages in complete silence.
 */
describe("antigravity drift reporting", () => {
  let warnings: string[] = [];
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    warnings = [];
    originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  const summary = { createdTime: "2026-05-10T12:00:00.000Z" };

  it("reports an unhandled step type that was carrying text", () => {
    parseAntigravityRuntimeSteps(
      "cascade-drift",
      [
        {
          type: "CORTEX_STEP_TYPE_BRAND_NEW",
          metadata: { createdAt: "2026-05-10T12:00:00.000Z" },
          brandNew: { response: "content this reader just dropped" },
        },
      ],
      summary,
    );

    expect(warnings.join("\n")).toContain("CORTEX_STEP_TYPE_BRAND_NEW");
  });

  /**
   * The flood this project has already had once: bookkeeping steps are normal
   * and constant, so reporting them as drift makes the signal worthless.
   */
  it("stays quiet about an unhandled step type that carries nothing", () => {
    parseAntigravityRuntimeSteps(
      "cascade-quiet",
      [
        { type: "CORTEX_STEP_TYPE_INTERNAL_LATCH", metadata: { createdAt: "2026-05-10T12:00:00.000Z" } },
        {
          type: "CORTEX_STEP_TYPE_INTERNAL_FLAG",
          metadata: { createdAt: "2026-05-10T12:00:00.000Z" },
          internalFlag: { enabled: true, count: 3, note: "   " },
        },
      ],
      summary,
    );

    expect(warnings).toEqual([]);
  });

  it("stays quiet about a handled step type that simply had no content", () => {
    parseAntigravityRuntimeSteps(
      "cascade-empty",
      [
        {
          type: "CORTEX_STEP_TYPE_USER_INPUT",
          metadata: { createdAt: "2026-05-10T12:00:00.000Z" },
          userInput: {},
        },
      ],
      summary,
    );

    expect(warnings).toEqual([]);
  });

  it("reports a step whose type field has gone missing", () => {
    parseAntigravityRuntimeSteps(
      "cascade-untyped",
      [{ metadata: {}, plannerResponse: { response: "text with no type" } }],
      summary,
    );

    expect(warnings.join("\n")).toContain("no 'type' field");
  });

  /**
   * `HANDLED_STEP_TYPES` is what decides whether an unknown type is drift, so
   * it has to agree with the parser. A type the parser handles but this set
   * omits would be reported as drift on every scan for the rest of time.
   */
  it("lists exactly the step types the parser handles", () => {
    const handled = [...HANDLED_STEP_TYPES];
    const parsed = handled.filter((stepType) => {
      const messages = parseAntigravityRuntimeSteps(
        "cascade-cover",
        [stepTypeFixture(stepType)],
        summary,
      );
      return messages.length === 1;
    });

    expect(parsed.sort()).toEqual(handled.sort());
    expect(warnings).toEqual([]);
  });
});

/** A minimal step of the given type that the parser should turn into a message. */
function stepTypeFixture(stepType: string): Record<string, unknown> {
  const metadata = { createdAt: "2026-05-10T12:00:00.000Z" };
  const payloads: Record<string, Record<string, unknown>> = {
    CORTEX_STEP_TYPE_USER_INPUT: { userInput: { userResponse: "hello" } },
    CORTEX_STEP_TYPE_PLANNER_RESPONSE: { plannerResponse: { response: "hello" } },
    CORTEX_STEP_TYPE_CODE_ACTION: { codeAction: { description: "edited a file" } },
    CORTEX_STEP_TYPE_RUN_COMMAND: { runCommand: { commandLine: "npm test" } },
    CORTEX_STEP_TYPE_VIEW_FILE: { viewFile: { path: "/a/b.ts" } },
    CORTEX_STEP_TYPE_FIND: { find: { query: "needle" } },
    CORTEX_STEP_TYPE_LIST_DIRECTORY: { listDirectory: { path: "/a" } },
    CORTEX_STEP_TYPE_SEARCH_WEB: { searchWeb: { query: "needle" } },
    CORTEX_STEP_TYPE_READ_URL_CONTENT: { readUrlContent: { url: "https://example.com" } },
    CORTEX_STEP_TYPE_COMMAND_STATUS: {},
    CORTEX_STEP_TYPE_ASK_QUESTION: {
      askQuestion: { questions: [{ question: "Which one?", options: [{ id: "a", text: "This one" }] }] },
    },
    CORTEX_STEP_TYPE_INVOKE_SUBAGENT: {
      invokeSubagent: { subagents: [{ typeName: "reviewer", initialPrompt: "look at it" }], results: [] },
    },
    CORTEX_STEP_TYPE_MCP_TOOL: {
      mcpTool: { serverName: "xtctx", toolCall: { name: "xtctx_recent_sessions" } },
    },
  };

  return { type: stepType, metadata, ...(payloads[stepType] ?? {}) };
}

/**
 * The known-gap list is the reason the drift check means anything: without it
 * every scan reports twelve types this reader has never extracted, and a
 * warning that always fires is one nobody reads.
 */
describe("known-unhandled antigravity step types", () => {
  it("does not overlap the handled set", () => {
    const both = [...KNOWN_UNHANDLED_STEP_TYPES].filter((type) => HANDLED_STEP_TYPES.has(type));
    expect(both).toEqual([]);
  });

  it("stays quiet about a known gap, and speaks up about a genuinely new type", () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    };

    try {
      parseAntigravityRuntimeSteps(
        "cascade-known",
        [...KNOWN_UNHANDLED_STEP_TYPES].map((type) => ({
          type,
          metadata: {},
          payload: { text: "content this reader knowingly does not extract" },
        })),
        {},
      );
      expect(warnings).toEqual([]);

      parseAntigravityRuntimeSteps(
        "cascade-new",
        [{ type: "CORTEX_STEP_TYPE_INVENTED_LATER", metadata: {}, payload: { text: "new content" } }],
        {},
      );
      expect(warnings.join("\n")).toContain("CORTEX_STEP_TYPE_INVENTED_LATER");
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("antigravity steps that record a decision", () => {
  const summary = { createdTime: "2026-05-10T12:00:00.000Z" };

  /**
   * Which option the user picked is a decision that exists nowhere else — not
   * in the code, not in the diff. It is the reason a later session can tell
   * what was chosen from what was merely considered.
   */
  it("keeps a question, its options, and which one was chosen", () => {
    const [message] = parseAntigravityRuntimeSteps(
      "cascade-ask",
      [
        {
          type: "CORTEX_STEP_TYPE_ASK_QUESTION",
          metadata: { createdAt: "2026-05-10T12:00:00.000Z" },
          status: "COMPLETED",
          askQuestion: {
            questions: [
              {
                question: "Which store should the index live in?",
                options: [
                  { id: "a", text: "SQLite" },
                  { id: "b", text: "Flat JSON" },
                ],
                selectedOptionIds: ["a"],
              },
            ],
          },
        },
      ],
      summary,
    );

    expect(message.content).toContain("Which store should the index live in?");
    expect(message.content).toContain("[chosen] SQLite");
    expect(message.content).toContain("[ ] Flat JSON");
    expect(message.toolName).toBe("ask_question");
    expect(message.role).toBe("assistant");
  });

  it("falls back to the requested interaction when the answer has not come back", () => {
    const [message] = parseAntigravityRuntimeSteps(
      "cascade-ask-pending",
      [
        {
          type: "CORTEX_STEP_TYPE_ASK_QUESTION",
          metadata: {},
          status: "PENDING",
          requestedInteraction: {
            askQuestion: { questions: [{ question: "Ship it?", options: [{ id: "y", text: "Yes" }] }] },
          },
        },
      ],
      summary,
    );

    expect(message.content).toContain("Ship it?");
    expect(message.content).toContain("[ ] Yes");
  });

  it("drops an ask-question step that carries only its status", () => {
    expect(
      parseAntigravityRuntimeSteps(
        "cascade-ask-empty",
        [{ type: "CORTEX_STEP_TYPE_ASK_QUESTION", metadata: {}, status: "RUNNING" }],
        summary,
      ),
    ).toEqual([]);
  });

  it("keeps the prompt each subagent was given, and where its log went", () => {
    const [message] = parseAntigravityRuntimeSteps(
      "cascade-subagent",
      [
        {
          type: "CORTEX_STEP_TYPE_INVOKE_SUBAGENT",
          metadata: {},
          invokeSubagent: {
            subagents: [
              { typeName: "reviewer", role: "REVIEW", initialPrompt: "Audit the retry logic", model: "gemini-3-pro" },
            ],
            results: [{ conversationId: "sub-1", logAbsoluteUri: "file:///logs/sub-1.md" }],
          },
        },
      ],
      summary,
    );

    expect(message.content).toContain("[Subagent] reviewer (gemini-3-pro)");
    expect(message.content).toContain("Audit the retry logic");
    expect(message.content).toContain("file:///logs/sub-1.md");
    expect(message.toolName).toBe("invoke_subagent");
    expect(message.model).toBe("gemini-3-pro");
  });

  it("does not claim a single model when subagents used different ones", () => {
    const [message] = parseAntigravityRuntimeSteps(
      "cascade-subagent-mixed",
      [
        {
          type: "CORTEX_STEP_TYPE_INVOKE_SUBAGENT",
          metadata: {},
          invokeSubagent: {
            subagents: [
              { typeName: "a", initialPrompt: "one", model: "gemini-3-pro" },
              { typeName: "b", initialPrompt: "two", model: "gemini-3-flash" },
            ],
            results: [],
          },
        },
      ],
      summary,
    );

    expect(message.model).toBeUndefined();
    expect(message.content).toContain("one");
    expect(message.content).toContain("two");
  });

  it("keeps an MCP call with its server, arguments and result", () => {
    const [message] = parseAntigravityRuntimeSteps(
      "cascade-mcp",
      [
        {
          type: "CORTEX_STEP_TYPE_MCP_TOOL",
          metadata: {},
          mcpTool: {
            serverName: "xtctx",
            toolCall: { id: "1", name: "xtctx_recent_sessions", argumentsJson: '{"limit":5}' },
            resultString: "3 sessions",
          },
        },
      ],
      summary,
    );

    expect(message.content).toContain("[MCP] xtctx/xtctx_recent_sessions");
    expect(message.content).toContain('{"limit":5}');
    expect(message.content).toContain("Result:\n3 sessions");
    expect(message.toolName).toBe("mcp:xtctx/xtctx_recent_sessions");
  });

  /**
   * A tool that was tried and failed is often why a session went the way it
   * did, so the failure is kept rather than dropped as an empty result.
   */
  it("keeps a failed MCP call and its error", () => {
    const [message] = parseAntigravityRuntimeSteps(
      "cascade-mcp-error",
      [
        {
          type: "CORTEX_STEP_TYPE_MCP_TOOL",
          metadata: {},
          error: { shortError: "server not reachable", isBenign: false },
          mcpTool: { serverName: "xtctx", toolCall: { id: "1", name: "xtctx_search_sessions" } },
        },
      ],
      summary,
    );

    expect(message.content).toContain("server not reachable");
  });

  it("drops an MCP step that names neither a server nor a tool", () => {
    expect(
      parseAntigravityRuntimeSteps(
        "cascade-mcp-empty",
        [{ type: "CORTEX_STEP_TYPE_MCP_TOOL", metadata: {}, mcpTool: { toolCall: {} } }],
        summary,
      ),
    ).toEqual([]);
  });
});
