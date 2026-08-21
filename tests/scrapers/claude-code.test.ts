import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ClaudeCodeScraper } from "@xtctx/scrapers/claude-code";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ClaudeCodeChunk } from "@xtctx/types/scraper";

describe("ClaudeCodeScraper", () => {
  let scraper: ClaudeCodeScraper;
  let tempDir: string;
  let stateDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "xtctx-claude-"));
    stateDir = await mkdtemp(join(tmpdir(), "xtctx-state-"));

    const projectDir = join(tempDir, "abc123");
    await mkdir(projectDir, { recursive: true });

    await writeFile(
      join(projectDir, "session-001.jsonl"),
      [
        '{"type":"human","content":"Help me set up vitest","timestamp":"2026-02-24T10:00:00Z"}',
        '{"type":"assistant","content":"I\'ll create the config.","timestamp":"2026-02-24T10:00:05Z"}',
      ].join("\n") + "\n",
    );

    scraper = new ClaudeCodeScraper(tempDir, stateDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  it("detects claude code installation", async () => {
    expect(await scraper.detect()).toBe(true);
  });

  it("assigns stable messageIndex across full and incremental scrapes", async () => {
    const projectDir = join(tempDir, "index-stability");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "session-idx.jsonl"),
      [
        '{"type":"human","content":"first","timestamp":"2026-02-24T10:00:00Z"}',
        '{"type":"assistant","content":"","timestamp":"2026-02-24T10:00:01Z"}',
        '{"type":"human","content":"third","timestamp":"2026-02-24T10:00:02Z"}',
      ].join("\n") + "\n",
    );

    const full: ClaudeCodeChunk[] = [];
    for await (const chunk of scraper.fullSync()) full.push(chunk);
    const incremental: ClaudeCodeChunk[] = [];
    for await (const chunk of scraper.scrape(new Date("2026-02-24T10:00:01.500Z"))) {
      incremental.push(chunk);
    }

    const fullThird = full.find((chunk) => chunk.content === "third");
    const incrementalThird = incremental.find((chunk) => chunk.content === "third");
    expect(fullThird?.metadata.messageIndex).toBe(2);
    expect(incrementalThird?.metadata.messageIndex).toBe(2);
  });

  it("keeps records with missing timestamps on full sync", async () => {
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const projectDir = join(tempDir, "missing-ts");
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, "session-ts.jsonl"),
        '{"type":"human","content":"no timestamp here"}\n',
      );

      const chunks: ClaudeCodeChunk[] = [];
      for await (const chunk of scraper.fullSync()) chunks.push(chunk);

      expect(chunks.some((chunk) => chunk.content === "no timestamp here")).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  it("continues past an unreadable transcript file", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      const projectDir = join(tempDir, "with-bad-file");
      // A directory named *.jsonl passes the extension filter and fails to stream.
      await mkdir(join(projectDir, "aaa-bad.jsonl"), { recursive: true });
      await writeFile(
        join(projectDir, "good.jsonl"),
        '{"type":"human","content":"still scraped","timestamp":"2026-02-24T10:00:00Z"}\n',
      );

      const chunks: ClaudeCodeChunk[] = [];
      for await (const chunk of scraper.fullSync()) chunks.push(chunk);

      expect(chunks.some((chunk) => chunk.content === "still scraped")).toBe(true);
      expect(warnings.some((warning) => warning.includes("unreadable"))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  /**
   * Drift warnings are the one signal the product promises instead of silent
   * data loss, so they have to stay readable. A record type Claude Code added
   * without telling us appears in every transcript, and warning per record
   * turned that into 344 warnings and 74KB of stderr in a single scan — the
   * signal was still there and nobody could see it.
   */
  it("warns once per kind of surprise, not once per record", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      const projectDir = join(tempDir, "repeated-surprise");
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, "noisy.jsonl"),
        Array.from(
          { length: 25 },
          (_, i) =>
            `{"type":"wibble","content":"x","timestamp":"2026-02-24T10:00:0${i % 10}Z"}`,
        ).join("\n") + "\n",
      );

      const chunks: ClaudeCodeChunk[] = [];
      for await (const chunk of scraper.fullSync()) chunks.push(chunk);

      const unknownType = warnings.filter((warning) => warning.includes("wibble"));
      expect(unknownType).toHaveLength(1);
      expect(unknownType[0]).toContain("25");
    } finally {
      console.warn = origWarn;
    }
  });

  it("does not treat a mode record as drift", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      const projectDir = join(tempDir, "mode-records");
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, "modes.jsonl"),
        '{"type":"mode","mode":"normal","sessionId":"abc"}\n',
      );

      const chunks: ClaudeCodeChunk[] = [];
      for await (const chunk of scraper.fullSync()) chunks.push(chunk);

      expect(warnings).toEqual([]);
    } finally {
      console.warn = origWarn;
    }
  });

  /**
   * The branch comes from what the tool wrote at the time, never from asking
   * git during indexing: indexing happens long after the session, often from
   * a different branch, so `git rev-parse` now would label old work with
   * today's branch.
   */
  it("records the branch the session was actually on", async () => {
    const projectDir = join(tempDir, "with-branch");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "branchy.jsonl"),
      JSON.stringify({
        type: "human",
        content: "work on the parser",
        timestamp: "2026-02-24T10:00:00Z",
        gitBranch: "feat/parser",
      }) + "\n",
    );

    const chunks: ClaudeCodeChunk[] = [];
    for await (const chunk of scraper.fullSync()) chunks.push(chunk);

    const found = chunks.find((chunk) => chunk.content === "work on the parser");
    expect(found?.metadata.gitBranch).toBe("feat/parser");
  });

  it("leaves the branch unset when the transcript does not record one", async () => {
    const chunks: ClaudeCodeChunk[] = [];
    for await (const chunk of scraper.fullSync()) chunks.push(chunk);

    expect(chunks[0].metadata.gitBranch).toBeUndefined();
  });

  /**
   * Caught by `npm run capture:formats` the day it appeared: Claude Code
   * started writing `{"type":"atis-latch","atis":"","sessionId":"..."}`, 18 of
   * them in one transcript. Bookkeeping with no conversational content, like
   * `mode` before it — but unknown types warn, so without this it reports
   * drift on every scan forever.
   */
  it("does not treat an atis-latch record as drift", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      const projectDir = join(tempDir, "atis-records");
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        join(projectDir, "atis.jsonl"),
        '{"type":"atis-latch","atis":"","sessionId":"abc"}\n',
      );

      const chunks: ClaudeCodeChunk[] = [];
      for await (const chunk of scraper.fullSync()) chunks.push(chunk);

      expect(warnings).toEqual([]);
    } finally {
      console.warn = origWarn;
    }
  });

  it("scrapes conversation chunks from JSONL", async () => {
    const chunks: ClaudeCodeChunk[] = [];

    for await (const chunk of scraper.fullSync()) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBe(2);
    expect(chunks[0].role).toBe("user");
    expect(chunks[0].content).toBe("Help me set up vitest");
    expect(chunks[1].role).toBe("assistant");
  });

  it("maps claude types to standard roles", async () => {
    const chunks: ClaudeCodeChunk[] = [];

    for await (const chunk of scraper.fullSync()) {
      chunks.push(chunk);
    }

    expect(chunks[0].role).toBe("user");
    expect(chunks[1].role).toBe("assistant");
  });

  it("parses current Claude message records and ignores non-message events", async () => {
    const projectDir = join(tempDir, "current-format");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "session-002.jsonl"),
      [
        JSON.stringify({
          type: "queue-operation",
          timestamp: "2026-02-24T10:00:00Z",
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-02-24T10:00:01Z",
          message: {
            role: "user",
            content: "Continue the handoff refactor",
          },
        }),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-02-24T10:00:02Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Updated the setup flow" }],
          },
        }),
        JSON.stringify({
          type: "attachment",
          timestamp: "2026-02-24T10:00:03Z",
        }),
      ].join("\n") + "\n",
    );

    const chunks: ClaudeCodeChunk[] = [];
    for await (const chunk of scraper.fullSync()) {
      if (chunk.sessionId === "session-002") {
        chunks.push(chunk);
      }
    }

    expect(chunks.map((chunk) => [chunk.role, chunk.content])).toEqual([
      ["user", "Continue the handoff refactor"],
      ["assistant", "Updated the setup flow"],
    ]);
  });

  it("excludes a prefix-matched sibling whose records carry no cwd", async () => {
    // The directory pre-filter is deliberately wide so sessions started in a
    // subdirectory still qualify, and per-record `cwd` decides. But a record
    // with no `cwd` defaulted to "mine", which let a plain sibling directory
    // (`proj-v2` next to `proj`) through. When the directory only matched by
    // prefix, absent provenance must mean "not mine".
    await writeClaudeSession(
      join(tempDir, "H--work-proj"),
      "session-mine",
      "my project",
      "H:\\work\\proj",
    );
    await writeClaudeSession(
      join(tempDir, "H--work-proj-v2"),
      "session-v2",
      "V2LEAK content from the sibling project",
    );

    const scoped = new ClaudeCodeScraper(tempDir, stateDir, "H:\\work\\proj");
    const chunks: ClaudeCodeChunk[] = [];
    for await (const chunk of scoped.fullSync()) chunks.push(chunk);

    expect(chunks.map((chunk) => chunk.sessionId)).toEqual(["session-mine"]);
  });

  it("keeps cwd-less records in the project's own store directory", async () => {
    // An exact directory match is provenance in itself, so records without a
    // `cwd` there (metadata-shaped records) must not be dropped.
    await writeClaudeSession(
      join(tempDir, "H--work-proj"),
      "session-nocwd",
      "no cwd but exact directory",
    );

    const scoped = new ClaudeCodeScraper(tempDir, stateDir, "H:\\work\\proj");
    const chunks: ClaudeCodeChunk[] = [];
    for await (const chunk of scoped.fullSync()) chunks.push(chunk);

    expect(chunks.map((chunk) => chunk.sessionId)).toEqual(["session-nocwd"]);
  });

  it("excludes a sibling project whose encoded directory shares the prefix", async () => {
    // `H:\projects\...\xtctx--secret` encodes to a directory name starting
    // with the real project's encoded name, so prefix matching served another
    // project's transcripts. Records carry their own `cwd`, which is
    // unambiguous — use it.
    await writeClaudeSession(
      join(tempDir, "H--projects-private-needs-work-xtctx"),
      "session-mine",
      "my project",
      "H:\\projects\\private\\needs-work\\xtctx",
    );
    await writeClaudeSession(
      join(tempDir, "H--projects-private-needs-work-xtctx--secret"),
      "session-sibling",
      "SIBLING SECRET",
      "H:\\projects\\private\\needs-work\\xtctx--secret",
    );

    const scoped = new ClaudeCodeScraper(
      tempDir,
      stateDir,
      "H:\\projects\\private\\needs-work\\xtctx",
    );
    const chunks: ClaudeCodeChunk[] = [];
    for await (const chunk of scoped.fullSync()) chunks.push(chunk);

    expect(chunks.map((chunk) => chunk.sessionId)).toEqual(["session-mine"]);
  });

  it("includes sessions started from a subdirectory of the project", async () => {
    await writeClaudeSession(
      join(tempDir, "H--projects-private-needs-work-xtctx-src"),
      "session-subdir",
      "work from src",
      "H:\\projects\\private\\needs-work\\xtctx\\src",
    );

    const scoped = new ClaudeCodeScraper(
      tempDir,
      stateDir,
      "H:\\projects\\private\\needs-work\\xtctx",
    );
    const chunks: ClaudeCodeChunk[] = [];
    for await (const chunk of scoped.fullSync()) chunks.push(chunk);

    expect(chunks.map((chunk) => chunk.sessionId)).toEqual(["session-subdir"]);
  });

  it("limits project-scoped scrapers to matching Claude project directories", async () => {
    await writeClaudeSession(
      join(tempDir, "H--projects-private-needs-work-xtctx"),
      "session-xtctx",
      "xtctx handoff",
    );
    await writeClaudeSession(
      join(tempDir, "H--projects-private-other"),
      "session-other",
      "unrelated project",
    );

    const scoped = new ClaudeCodeScraper(
      tempDir,
      stateDir,
      "H:\\projects\\private\\needs-work\\xtctx",
    );
    const chunks: ClaudeCodeChunk[] = [];
    for await (const chunk of scoped.fullSync()) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.sessionId)).toEqual(["session-xtctx"]);
    expect(chunks[0].content).toBe("xtctx handoff");
  });
});

async function writeClaudeSession(
  projectDir: string,
  sessionId: string,
  content: string,
  cwd?: string,
): Promise<void> {
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: "user",
      timestamp: "2026-02-24T10:00:01Z",
      ...(cwd ? { cwd } : {}),
      message: {
        role: "user",
        content,
      },
    }) + "\n",
  );
}
