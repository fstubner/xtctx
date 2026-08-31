import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { promisify } from "node:util";
import { basename, dirname, extname, join } from "node:path";
import type { AntigravityChunk } from "../types/scraper.js";
import { AbstractScraper, estimateTokens, toDate } from "./base.js";
import { recordDrift, withDriftReport } from "./drift-log.js";

const execFileAsync = promisify(execFile);
const SCRAPER_NAME = "antigravity";
const LANGUAGE_SERVER_SERVICE = "exa.language_server_pb.LanguageServerService";

/**
 * Step types Antigravity emits that this reader knowingly does not extract.
 *
 * Observed 2026-08-23 against a live language server across 24 trajectories.
 * Every one carries text, so they are a gap in coverage — not evidence that
 * Antigravity changed anything, and so not drift. A warning that fires on
 * every scan for a known limitation is the crying-wolf failure this project
 * has already made once (`atis-latch`, 4ee257a).
 *
 * Listing them is what makes the drift check mean something: a type in neither
 * this set nor `HANDLED_STEP_TYPES` really is new.
 *
 * What remains here is bookkeeping and bulk. `CHECKPOINT` and
 * `CONVERSATION_HISTORY` restate steps recorded elsewhere; `EPHEMERAL_MESSAGE`
 * is transient UI; `ERROR_MESSAGE` and `GENERIC` are the two largest by far
 * and are mostly retry and status noise. Extracting any of them would add
 * volume without adding much a later session could act on.
 */
export const KNOWN_UNHANDLED_STEP_TYPES = new Set([
  "CORTEX_STEP_TYPE_CHECKPOINT",
  "CORTEX_STEP_TYPE_CONVERSATION_HISTORY",
  "CORTEX_STEP_TYPE_EPHEMERAL_MESSAGE",
  "CORTEX_STEP_TYPE_ERROR_MESSAGE",
  "CORTEX_STEP_TYPE_GENERATE_IMAGE",
  "CORTEX_STEP_TYPE_GENERIC",
  "CORTEX_STEP_TYPE_GREP_SEARCH",
  "CORTEX_STEP_TYPE_KNOWLEDGE_ARTIFACTS",
  "CORTEX_STEP_TYPE_SYSTEM_MESSAGE",
]);

/**
 * Step types this reader turns into a message.
 *
 * Kept beside `parseRuntimeStep` and checked against it by a test, because
 * this set is what the drift report means by "known": a type handled there but
 * missing here would be reported as drift on every scan, and one listed here
 * but silently dropped there would never be reported at all.
 */
export const HANDLED_STEP_TYPES = new Set([
  "CORTEX_STEP_TYPE_USER_INPUT",
  "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
  "CORTEX_STEP_TYPE_CODE_ACTION",
  "CORTEX_STEP_TYPE_RUN_COMMAND",
  "CORTEX_STEP_TYPE_VIEW_FILE",
  "CORTEX_STEP_TYPE_FIND",
  "CORTEX_STEP_TYPE_LIST_DIRECTORY",
  "CORTEX_STEP_TYPE_SEARCH_WEB",
  "CORTEX_STEP_TYPE_READ_URL_CONTENT",
  "CORTEX_STEP_TYPE_COMMAND_STATUS",
  "CORTEX_STEP_TYPE_ASK_QUESTION",
  "CORTEX_STEP_TYPE_INVOKE_SUBAGENT",
  "CORTEX_STEP_TYPE_MCP_TOOL",
]);

interface AntigravityArtifactMetadata {
  artifactType?: string;
  summary?: string;
  updatedAt?: string;
  version?: string;
}

interface AntigravityArtifact {
  sessionId: string;
  sourcePath: string;
  artifactName: string;
  artifactType?: string;
  summary?: string;
  timestamp: Date;
  body: string;
  referencedFiles: string[];
}

export interface AntigravityRuntimeMessage {
  sessionId: string;
  timestamp: Date;
  role: AntigravityChunk["role"];
  content: string;
  referencedFiles: string[];
  sourcePath?: string;
  stepType?: string;
  toolName?: string;
  model?: string;
}

export interface AntigravityRuntimeConversation {
  sessionId: string;
  title?: string;
  createdAt?: Date;
  workspaces: string[];
  messages: AntigravityRuntimeMessage[];
}

interface AntigravityEndpoint {
  port: number;
  csrf: string;
  pid: number;
}

interface AntigravityProcess {
  pid: number;
  csrf: string;
  commandLine: string;
}

/**
 * What a runtime listing came back with, and whether it is the whole picture.
 *
 * A bare array means "this is everything" — the shape every existing caller and
 * test stub already returns. `degradation` is set when the language server was
 * there but could not be fully read: the transcripts exist, this scan just did
 * not get them. That difference decides whether the reader may advance its
 * incremental cursor, so it cannot be flattened into an empty array.
 */
export interface AntigravityRuntimeListing {
  conversations: AntigravityRuntimeConversation[];
  /** Human-readable reason the listing is incomplete, if it is. */
  degradation?: string;
}

export interface AntigravityRuntimeClient {
  listConversations(
    conversationsDir: string,
  ): Promise<AntigravityRuntimeConversation[] | AntigravityRuntimeListing>;
}

function normalizeListing(
  value: AntigravityRuntimeConversation[] | AntigravityRuntimeListing,
): AntigravityRuntimeListing {
  return Array.isArray(value) ? { conversations: value } : value;
}

export class AntigravityScraper extends AbstractScraper<AntigravityChunk> {
  readonly tool = "antigravity";

  constructor(
    private readonly antigravityRoot: string,
    stateDir: string,
    private readonly projectRoot?: string,
    private readonly runtimeClient: AntigravityRuntimeClient = new AntigravityLanguageServerClient(
      projectRoot,
    ),
  ) {
    super(stateDir);
  }

  async detect(): Promise<boolean> {
    try {
      const target = await stat(this.antigravityRoot);
      if (!target.isDirectory()) {
        return false;
      }

      // Deliberately not mcp_config.json: xtctx's own setup writes that file,
      // so treating it as evidence made a diagnostic report its own side
      // effect as an installed tool. Only Antigravity's own state counts.
      return (await pathIsDirectory(join(this.antigravityRoot, "brain"))) ||
        (await pathIsDirectory(join(this.antigravityRoot, "conversations")));
    } catch {
      return false;
    }
  }

  getStorePaths(): string[] {
    return [this.antigravityRoot];
  }

  async *scrape(since?: Date): AsyncIterable<AntigravityChunk> {
    const state = await this.getLastScrapedPosition();
    const cutoff = since ?? state.lastTimestamp;
    yield* withDriftReport(SCRAPER_NAME, this.readArtifacts(cutoff), this.stateDir);
  }

  async *fullSync(): AsyncIterable<AntigravityChunk> {
    yield* withDriftReport(SCRAPER_NAME, this.readArtifacts(new Date(0)), this.stateDir);
  }

  parseRaw(raw: unknown): AntigravityChunk {
    const value = raw as Record<string, unknown>;
    const content = toStringValue(value.content) ?? "";
    return {
      tool: "antigravity",
      sessionId: toStringValue(value.sessionId) ?? "unknown",
      timestamp: toDate(value.timestamp),
      role: normalizeRole(toStringValue(value.role)),
      content,
      metadata: {
        messageIndex: toMessageIndex(value.messageIndex),
        tokenEstimate: estimateTokens(content),
        referencedFiles: toStringArray(value.referencedFiles),
        artifactType: toStringValue(value.artifactType),
        artifactName: toStringValue(value.artifactName),
        summary: toStringValue(value.summary),
        sourcePath: toStringValue(value.sourcePath),
        toolName: toStringValue(value.toolName),
        model: toStringValue(value.model),
      },
    };
  }

  private async *readArtifacts(since: Date): AsyncIterable<AntigravityChunk> {
    const { chunks: runtimeChunks, degradation } = await this.readRuntimeChunks(since);
    if (degradation) {
      recordDrift(SCRAPER_NAME, `antigravity-ls:${this.antigravityRoot}`, degradation);
    }
    if (runtimeChunks.length > 0) {
      for (const chunk of runtimeChunks) {
        yield chunk;
      }
      failIfDegraded(degradation);
      return;
    }

    const brainDir = join(this.antigravityRoot, "brain");
    const sessionDirs = await listDirectories(brainDir);
    let fallbackChunks = 0;
    const fallbackSessions = new Set<string>();

    for (const sessionDir of sessionDirs) {
      const sessionId = basename(sessionDir);
      const artifacts = await this.readSessionArtifacts(sessionDir, sessionId);

      artifacts.sort((left, right) => {
        const time = left.timestamp.getTime() - right.timestamp.getTime();
        return time === 0 ? left.sourcePath.localeCompare(right.sourcePath) : time;
      });

      for (const [messageIndex, artifact] of artifacts.entries()) {
        if (artifact.timestamp <= since) {
          continue;
        }

        fallbackChunks += 1;
        fallbackSessions.add(artifact.sessionId);
        yield this.parseRaw({
          sessionId: artifact.sessionId,
          timestamp: artifact.timestamp,
          messageIndex,
          content: formatArtifactContent(artifact),
          referencedFiles: artifact.referencedFiles,
          artifactType: artifact.artifactType,
          artifactName: artifact.artifactName,
          summary: artifact.summary,
          sourcePath: artifact.sourcePath,
        });
      }
    }

    // Serving brain artifacts instead of the language server is not a quiet
    // equivalent. Measured against the real store on a machine where the
    // server was unreachable: 45 sessions produced 99 chunks, 27 of them a
    // single chunk, and every one was labelled `assistant` because artifacts
    // carry no role. Not one user turn survived — which for a handoff tool
    // loses the half that matters, the instructions rather than the replies.
    //
    // Nothing said so. `degradation` is only set when the listing throws or no
    // server is found, so a listing that returns zero conversations fell
    // through to here reporting success. This is the "warn, never silently
    // drop" rule applied to the case that was slipping past it.
    //
    // Only when the fallback actually served something: a machine with no
    // Antigravity history has nothing to warn about.
    if (fallbackChunks > 0) {
      recordDrift(
        SCRAPER_NAME,
        `antigravity-brain:${this.antigravityRoot}`,
        `language server returned nothing; served ${fallbackChunks} brain artifact(s) across ` +
          `${fallbackSessions.size} session(s) instead. Artifacts carry no role, so user turns ` +
          `are absent and every chunk reads as assistant.`,
      );
    }

    failIfDegraded(degradation);
  }

  private async readSessionArtifacts(
    sessionDir: string,
    sessionId: string,
  ): Promise<AntigravityArtifact[]> {
    const names = await listFileNames(sessionDir);
    const artifacts: AntigravityArtifact[] = [];

    for (const name of names) {
      if (!isReadableArtifactName(name)) {
        continue;
      }

      const sourcePath = join(sessionDir, name);
      const body = await readTextIfExists(sourcePath);
      if (!body?.trim()) {
        continue;
      }

      const metadata = await readArtifactMetadata(`${sourcePath}.metadata.json`);
      const timestamp = await artifactTimestamp(sourcePath, metadata);
      const candidate: AntigravityArtifact = {
        sessionId,
        sourcePath,
        artifactName: name,
        artifactType: metadata.artifactType,
        summary: metadata.summary,
        timestamp,
        body,
        referencedFiles: extractReferencedFiles(body),
      };

      if (this.projectRoot && !artifactMatchesProject(candidate, this.projectRoot, this.antigravityRoot)) {
        continue;
      }

      artifacts.push(candidate);
    }

    return artifacts;
  }

  private async readRuntimeChunks(
    since: Date,
  ): Promise<{ chunks: AntigravityChunk[]; degradation?: string }> {
    const { conversations, degradation } = await this.safeListRuntimeConversations();
    const chunks: AntigravityChunk[] = [];

    for (const conversation of conversations) {
      if (this.projectRoot && !runtimeConversationMatchesProject(conversation, this.projectRoot, this.antigravityRoot)) {
        continue;
      }

      const sortedMessages = conversation.messages
        .filter((message) => message.content.trim().length > 0)
        .sort((left, right) => {
          const time = left.timestamp.getTime() - right.timestamp.getTime();
          return time === 0 ? left.content.localeCompare(right.content) : time;
        });

      for (const [messageIndex, message] of sortedMessages.entries()) {
        if (message.timestamp <= since) {
          continue;
        }

        chunks.push(this.parseRaw({
          sessionId: conversation.sessionId,
          timestamp: message.timestamp,
          messageIndex,
          role: message.role,
          content: message.content,
          referencedFiles: message.referencedFiles,
          sourcePath: message.sourcePath ?? `antigravity-ls:${conversation.sessionId}`,
          artifactType: "ANTIGRAVITY_LANGUAGE_SERVER_TRANSCRIPT",
          artifactName: message.stepType,
          summary: conversation.title,
          toolName: message.toolName,
          model: message.model,
        }));
      }
    }

    return degradation ? { chunks, degradation } : { chunks };
  }

  private async safeListRuntimeConversations(): Promise<AntigravityRuntimeListing> {
    try {
      return normalizeListing(
        await this.runtimeClient.listConversations(join(this.antigravityRoot, "conversations")),
      );
    } catch (err) {
      // The listing threw rather than returning nothing, which is a failure to
      // read Antigravity — not evidence that Antigravity has nothing to read.
      return { conversations: [], degradation: `runtime listing failed: ${(err as Error).message}` };
    }
  }
}

/**
 * Whether a trajectory is worth fetching, decided from its summary alone.
 *
 * Antigravity's summaries carry the workspace a session belonged to, and
 * fetching a trajectory means pulling its entire transcript over the wire with
 * a 30s timeout. Doing that for every session on the machine and filtering
 * afterwards cost 155 round trips here to keep a handful.
 *
 * A summary that names workspaces and names none of ours belongs to another
 * project, so it is skipped — which also means another project's transcript is
 * never fetched at all, rather than fetched and then discarded.
 *
 * A summary with no workspace at all is not evidence of anything, so it is
 * still fetched: the message bodies may carry the only path evidence there is.
 */
export function shouldFetchTrajectory(
  summary: Record<string, unknown>,
  projectRoot?: string,
  antigravityRoot?: string,
): boolean {
  if (!projectRoot) {
    return true;
  }

  const workspaces = extractWorkspaceUris(summary);
  if (workspaces.length === 0) {
    return true;
  }

  return workspaces.some((workspace) =>
    textMentionsProject(workspace, projectRoot, antigravityRoot),
  );
}

class AntigravityLanguageServerClient implements AntigravityRuntimeClient {
  constructor(private readonly projectRoot?: string) {}

  async listConversations(conversationsDir: string): Promise<AntigravityRuntimeListing> {
    if (process.env.XTCTX_DISABLE_ANTIGRAVITY_RUNTIME === "1") {
      // The language server is a machine-global service: there is exactly one
      // per install, and nothing in its arguments ties it to the transcript
      // directory this reader was pointed at. So a test that sandboxes `HOME`
      // and seeds a synthetic store still reached the real one, and
      // `verify:release` failed on any machine with Antigravity open. This is
      // the only way to isolate it, and it exists for that.
      return { conversations: [] };
    }

    const { endpoints, processesFound } = await discoverLanguageServerEndpoints();
    if (endpoints.length === 0) {
      const degradation = describeUnreachableServer(processesFound);
      return degradation ? { conversations: [], degradation } : { conversations: [] };
    }

    // Answering endpoints exist, so from here on an empty result means this
    // scan failed to read transcripts that are there — a different thing
    // entirely, and the one that used to be silent.
    const handledTally: HandledStepTally = new Map();
    let unanswered = 0;
    let unfetched = 0;

    const bySession = new Map<string, {
      endpoint: AntigravityEndpoint;
      summary: Record<string, unknown>;
    }>();

    for (const endpoint of endpoints) {
      const response = await callLanguageServer(endpoint, "GetAllCascadeTrajectories", {}, 5_000);
      if (response === null) {
        // The endpoint answered during discovery and has stopped answering
        // now, so its sessions are missing from this listing.
        unanswered += 1;
      }
      const summaries = isRecord(response?.trajectorySummaries)
        ? response.trajectorySummaries
        : {};
      for (const [sessionId, summary] of Object.entries(summaries)) {
        if (!isRecord(summary) || bySession.has(sessionId)) {
          continue;
        }
        bySession.set(sessionId, { endpoint, summary });
      }
    }

    const defaultEndpoint = endpoints[0];
    for (const sessionId of await listConversationFileIds(conversationsDir)) {
      if (!bySession.has(sessionId)) {
        bySession.set(sessionId, {
          endpoint: defaultEndpoint,
          summary: {
            summary: `[on-disk] ${sessionId.slice(0, 8)}`,
            stepCount: 1000,
          },
        });
      }
    }

    const worthFetching = [...bySession.entries()].filter(([, entry]) =>
      shouldFetchTrajectory(entry.summary, this.projectRoot, dirname(conversationsDir)),
    );

    // Sessions Antigravity records no workspace for still have to be fetched
    // to find out whose they are, and that is most of them. Fetching them one
    // after another made the scan as slow as the sum of every round trip, so
    // they go out in a small pool instead — same requests, same results, less
    // waiting. The pool is deliberately modest: this is someone's editor
    // answering on localhost, not a service built to be hammered.
    const fetched = await mapWithConcurrency<
      (typeof worthFetching)[number],
      AntigravityRuntimeConversation
    >(worthFetching, 6, async ([sessionId, entry]) => {
      const stepCount = toPositiveInteger(entry.summary.stepCount) ?? 1000;
      const response = await callLanguageServer(
        entry.endpoint,
        "GetCascadeTrajectorySteps",
        { cascadeId: sessionId, startIndex: 0, endIndex: stepCount + 10 },
        30_000,
      );
      let steps: unknown[] = [];
      if (response === null) {
        // Timed out or errored. The transcript is still there; this scan just
        // did not get it, which must not be mistaken for an empty session.
        unfetched += 1;
      } else if (Array.isArray(response.steps)) {
        steps = response.steps;
      } else if (Array.isArray(response.messages)) {
        steps = response.messages;
      } else {
        // The server answered, but with neither field this reader knows. Every
        // message in the session is dropped, and without this it is dropped in
        // silence — indistinguishable from a session that is simply empty.
        recordDrift(
          SCRAPER_NAME,
          `antigravity-ls:${sessionId}`,
          `trajectory response has neither 'steps' nor 'messages' (keys: ${Object.keys(response).sort().join(", ") || "none"})`,
        );
      }
      const messages = parseAntigravityRuntimeSteps(sessionId, steps, entry.summary, handledTally);
      if (messages.length === 0) {
        return null;
      }

      return {
        sessionId,
        title: toStringValue(entry.summary.summary),
        createdAt: toDate(entry.summary.createdTime),
        workspaces: extractWorkspaceUris(entry.summary),
        messages,
      };
    });

    const conversations = fetched.filter(
      (entry): entry is AntigravityRuntimeConversation => entry !== null,
    );

    reportHandledStepRenames(handledTally, `antigravity-ls:${conversationsDir}`);

    const reasons: string[] = [];
    if (unanswered > 0) {
      reasons.push(`${unanswered} of ${endpoints.length} language server endpoints stopped answering`);
    }
    if (unfetched > 0) {
      reasons.push(`${unfetched} of ${worthFetching.length} trajectories could not be fetched`);
    }

    return reasons.length > 0
      ? { conversations, degradation: reasons.join("; ") }
      : { conversations };
  }
}

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving order.
 *
 * One failed fetch must not lose the rest of the scan, so a rejection becomes
 * a null for that item rather than taking the whole batch down.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R | null>,
): Promise<Array<R | null>> {
  const results: Array<R | null> = new Array(items.length).fill(null);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = await worker(items[index]);
      } catch {
        results[index] = null;
      }
    }
  });

  await Promise.all(runners);
  return results;
}

export type HandledStepTally = Map<string, { seen: number; produced: number }>;

export function parseAntigravityRuntimeSteps(
  sessionId: string,
  steps: unknown[],
  summary: Record<string, unknown>,
  /**
   * Scan-wide tally of handled step types. Judging a rename needs every
   * session: one session can hold nothing but empty planner responses while
   * the scan as a whole has four hundred good ones, and reporting per session
   * called a working parser broken. Omitted, the check falls back to this
   * session alone, which is what the unit tests exercise.
   */
  tally?: HandledStepTally,
): AntigravityRuntimeMessage[] {
  const fallbackTimestamp = toDate(summary.createdTime);
  const messages: AntigravityRuntimeMessage[] = [];
  // The transcript comes off the language server, not off disk, so the session
  // is the only location there is to point at.
  const location = `antigravity-ls:${sessionId}`;
  const handledTally: HandledStepTally = tally ?? new Map();

  for (const step of steps) {
    if (!isRecord(step)) {
      recordDrift(SCRAPER_NAME, location, `trajectory step is ${describeValue(step)}, not an object`);
      continue;
    }

    const stepType = toStringValue(step.type) ?? "";
    const metadata = isRecord(step.metadata) ? step.metadata : {};
    const timestamp = validDate(toDate(metadata.createdAt)) ?? validDate(fallbackTimestamp) ?? new Date(0);
    const message = parseRuntimeStep(sessionId, step, stepType, timestamp);
    if (message) {
      messages.push(message);
      if (HANDLED_STEP_TYPES.has(stepType)) {
        const tally = handledTally.get(stepType) ?? { seen: 0, produced: 0 };
        tally.seen += 1;
        tally.produced += 1;
        handledTally.set(stepType, tally);
      }
      continue;
    }

    // An unhandled step type is only worth reporting when something was
    // actually lost. Antigravity's trajectories carry plenty of bookkeeping
    // steps that hold no conversation at all, and warning about those would
    // report normal operation as drift — the failure this project has already
    // made once, with `atis-latch`. A step whose payload holds text is a
    // different matter: that text was dropped.
    // Counted, not reported here. A handled step producing nothing is
    // ordinary: plenty of planner responses are empty placeholders. Reporting
    // each one made this fire 4047 times for a step type that was working
    // perfectly — the same crying-wolf failure, in a new place. What actually
    // indicates a renamed field is a type that yields nothing *at all*, and
    // that can only be judged once the whole session has been read.
    if (HANDLED_STEP_TYPES.has(stepType)) {
      const tally = handledTally.get(stepType) ?? { seen: 0, produced: 0 };
      tally.seen += 1;
      handledTally.set(stepType, tally);
      continue;
    }

    if (
      !HANDLED_STEP_TYPES.has(stepType) &&
      !KNOWN_UNHANDLED_STEP_TYPES.has(stepType) &&
      stepCarriesText(step)
    ) {
      // Deliberately just the type. Naming the payload fields was tried and
      // reverted: protobuf leaves optional fields out, so one type produced a
      // dozen distinct field lists — `CHECKPOINT` alone filled a fifth of the
      // ceiling on one machine. The type name is the actionable part anyway.
      recordDrift(
        SCRAPER_NAME,
        location,
        stepType.length === 0
          ? "trajectory step carrying text has no 'type' field — likely renamed"
          : `unhandled step type ${JSON.stringify(stepType)} carrying text`,
      );
    }
  }

  if (!tally) {
    reportHandledStepRenames(handledTally, location);
  }

  return messages;
}

/**
 * Report handled step types that appeared repeatedly and yielded nothing.
 *
 * That is the shape of a renamed field: if the parser still matched, at least
 * one of them would have produced a message. It found two real breaks the day
 * it was written — `find.query` and `listDirectory.directoryPath` had both
 * been gone for as long as anyone had looked, dropping every such step.
 *
 * A minimum count keeps a scan that happens to hold a couple of empty
 * placeholders from reading as a break.
 */
export function reportHandledStepRenames(tally: HandledStepTally, location: string): void {
  for (const [stepType, { seen, produced }] of tally) {
    if (produced === 0 && seen >= MIN_STEPS_BEFORE_RENAME_SUSPECTED) {
      recordDrift(
        SCRAPER_NAME,
        location,
        // No step count in the text: sessions differ in length, so embedding
        // it produced a distinct surprise per session and ate the ceiling. The
        // stored `records` count already says how often this was hit.
        `handled step type ${JSON.stringify(stepType)} yielded no messages at all — its payload fields may have been renamed`,
      );
    }
  }
}

/**
 * How many times a handled step type must appear, having produced nothing,
 * before it is treated as broken rather than merely empty.
 */
const MIN_STEPS_BEFORE_RENAME_SUSPECTED = 5;

function parseRuntimeStep(
  sessionId: string,
  step: Record<string, unknown>,
  stepType: string,
  timestamp: Date,
): AntigravityRuntimeMessage | null {
  if (stepType === "CORTEX_STEP_TYPE_USER_INPUT") {
    return parseUserInputStep(sessionId, step, stepType, timestamp);
  }
  if (stepType === "CORTEX_STEP_TYPE_PLANNER_RESPONSE") {
    return parsePlannerResponseStep(sessionId, step, stepType, timestamp);
  }
  if (stepType === "CORTEX_STEP_TYPE_CODE_ACTION") {
    return parseCodeActionStep(sessionId, step, stepType, timestamp);
  }
  if (stepType === "CORTEX_STEP_TYPE_RUN_COMMAND") {
    return parseRunCommandStep(sessionId, step, stepType, timestamp);
  }
  if (stepType === "CORTEX_STEP_TYPE_VIEW_FILE") {
    return parsePathToolStep(sessionId, step, stepType, timestamp, "view_file", "viewFile", [
      "absolutePathUri",
      "filePath",
      "path",
    ]);
  }
  if (stepType === "CORTEX_STEP_TYPE_FIND") {
    // `pattern` and `searchDirectory` are what the live server sends; `query`
    // was never present, so every find step was silently dropped until the
    // rename check above pointed at it. The old name is kept as a fallback.
    return parseSimpleToolStep(sessionId, step, stepType, timestamp, "find", "find", [
      "pattern",
      "searchDirectory",
      "query",
    ]);
  }
  if (stepType === "CORTEX_STEP_TYPE_LIST_DIRECTORY") {
    // `directoryPathUri` is the live field name; the two below never appeared,
    // so every list-directory step was dropped in silence.
    return parsePathToolStep(sessionId, step, stepType, timestamp, "list_dir", "listDirectory", [
      "directoryPathUri",
      "directoryPath",
      "path",
    ]);
  }
  if (stepType === "CORTEX_STEP_TYPE_SEARCH_WEB") {
    return parseSimpleToolStep(sessionId, step, stepType, timestamp, "search_web", "searchWeb", [
      "query",
      "summary",
    ]);
  }
  if (stepType === "CORTEX_STEP_TYPE_READ_URL_CONTENT") {
    return parseSimpleToolStep(sessionId, step, stepType, timestamp, "read_url", "readUrlContent", ["url"]);
  }
  if (stepType === "CORTEX_STEP_TYPE_COMMAND_STATUS") {
    return runtimeMessage(sessionId, timestamp, "tool", "[Check Command Status]", [], {
      stepType,
      toolName: "command_status",
    });
  }
  if (stepType === "CORTEX_STEP_TYPE_ASK_QUESTION") {
    return parseAskQuestionStep(sessionId, step, stepType, timestamp);
  }
  if (stepType === "CORTEX_STEP_TYPE_INVOKE_SUBAGENT") {
    return parseInvokeSubagentStep(sessionId, step, stepType, timestamp);
  }
  if (stepType === "CORTEX_STEP_TYPE_MCP_TOOL") {
    return parseMcpToolStep(sessionId, step, stepType, timestamp);
  }
  return null;
}

/**
 * A question the agent put to the user, with the options offered and whichever
 * was chosen.
 *
 * The chosen option is a decision the user made, which is exactly the kind of
 * thing a later session needs and cannot recover from the code. Antigravity
 * repeats the same questions under `requestedInteraction` and
 * `completedInteractions`; the top-level `askQuestion` is the one that carries
 * the selection, so it is preferred and the request is only a fallback.
 */
function parseAskQuestionStep(
  sessionId: string,
  step: Record<string, unknown>,
  stepType: string,
  timestamp: Date,
): AntigravityRuntimeMessage | null {
  const direct = isRecord(step.askQuestion) ? step.askQuestion : {};
  const requested = isRecord(step.requestedInteraction) ? step.requestedInteraction : {};
  const fallback = isRecord(requested.askQuestion) ? requested.askQuestion : {};
  const questions = Array.isArray(direct.questions)
    ? direct.questions
    : Array.isArray(fallback.questions)
      ? fallback.questions
      : [];
  const location = `antigravity-ls:${sessionId}`;

  const sections: string[] = [];
  for (const entry of questions) {
    if (!isRecord(entry)) continue;
    const question = toStringValue(entry.question);
    if (!question) continue;

    const options = Array.isArray(entry.options) ? entry.options.filter(isRecord) : [];
    const selectedIds = new Set(toStringArray(entry.selectedOptionIds));
    const optionIds = options
      .map((option) => toStringValue(option.id))
      .filter((id): id is string => Boolean(id));

    // Only claim a selection when the data can actually express one. If
    // `selectedOptionIds` or `option.id` were renamed, marking every option
    // `[ ]` would state that the user chose nothing — a confident, false record
    // of a decision, which is worse than dropping the step. "Unknown" and "not
    // chosen" have to look different.
    const canShowSelection = selectedIds.size > 0 && optionIds.length > 0;
    const matched = optionIds.some((id) => selectedIds.has(id));
    if (selectedIds.size > 0 && !matched) {
      recordDrift(
        SCRAPER_NAME,
        location,
        "ask-question selection matches none of the option ids — one of them may have been renamed",
      );
    }

    sections.push(`[Question] ${question}`);
    for (const option of options) {
      const text = toStringValue(option.text);
      if (!text) continue;
      if (!canShowSelection || !matched) {
        // Listed without a verdict: these were the choices, and which was taken
        // is not recorded here.
        sections.push(`  - ${text}`);
        continue;
      }
      const id = toStringValue(option.id);
      // Marked inline rather than reported separately, so the answer cannot be
      // read back without the question it answered.
      sections.push(`  ${id && selectedIds.has(id) ? "[chosen]" : "[ ]"} ${text}`);
    }
  }

  if (sections.length === 0) {
    // A step that only carries its status: the question lives in another step.
    return null;
  }

  const content = sections.join("\n");
  return runtimeMessage(sessionId, timestamp, "assistant", content, extractReferencedFiles(content), {
    stepType,
    toolName: "ask_question",
  });
}

/**
 * Subagents the session dispatched, and the prompt each was given.
 *
 * The prompt is the instruction that produced whatever the subagent did, so
 * without it a later reader sees the result of work with no record of what was
 * asked for. The subagent's own transcript is a separate conversation that
 * Antigravity stores elsewhere; only the pointer to it is kept here.
 */
function parseInvokeSubagentStep(
  sessionId: string,
  step: Record<string, unknown>,
  stepType: string,
  timestamp: Date,
): AntigravityRuntimeMessage | null {
  const invokeSubagent = isRecord(step.invokeSubagent) ? step.invokeSubagent : {};
  const subagents = Array.isArray(invokeSubagent.subagents) ? invokeSubagent.subagents : [];
  // Deliberately not filtered: `subagents` and `results` are matched by index,
  // so dropping a malformed entry from one shifts every later entry of the
  // other — printing one subagent's log under another subagent's name. Bad
  // entries are skipped where they are read instead.
  const results = Array.isArray(invokeSubagent.results) ? invokeSubagent.results : [];

  const sections: string[] = [];
  const models: string[] = [];
  for (const [index, entry] of subagents.entries()) {
    if (!isRecord(entry)) continue;
    const subagent = entry;
    const label = toStringValue(subagent.typeName) ?? toStringValue(subagent.role) ?? "subagent";
    const model = toStringValue(subagent.model);
    if (model) models.push(model);
    sections.push(`[Subagent] ${label}${model ? ` (${model})` : ""}`);

    const prompt = toStringValue(subagent.initialPrompt);
    if (prompt) sections.push(prompt);

    const result = results[index];
    const log = isRecord(result) ? toStringValue(result.logAbsoluteUri) : undefined;
    if (log) sections.push(`Log: ${log}`);
  }

  if (sections.length === 0) {
    return null;
  }

  const content = sections.join("\n");
  return runtimeMessage(sessionId, timestamp, "tool", content, extractReferencedFiles(content), {
    stepType,
    toolName: "invoke_subagent",
    // One model when they agree, so the common case reads as a plain value
    // rather than a repeated list.
    model: new Set(models).size === 1 ? models[0] : undefined,
  });
}

/**
 * An MCP tool call: which server, which tool, its arguments and its result.
 *
 * A failed call is kept too, and with its error — the fact that a tool was
 * tried and did not work is often the reason a session went the way it did.
 */
function parseMcpToolStep(
  sessionId: string,
  step: Record<string, unknown>,
  stepType: string,
  timestamp: Date,
): AntigravityRuntimeMessage | null {
  const mcpTool = isRecord(step.mcpTool) ? step.mcpTool : {};
  const toolCall = isRecord(mcpTool.toolCall) ? mcpTool.toolCall : {};
  const serverName = toStringValue(mcpTool.serverName);
  const toolName = toStringValue(toolCall.name);
  if (!serverName && !toolName) {
    return null;
  }

  const qualifiedName = [serverName, toolName].filter(Boolean).join("/");
  const error = isRecord(step.error) ? step.error : {};
  const sections = [
    `[MCP] ${qualifiedName}`,
    // `originalArgumentsJson` is what the model actually wrote; the other is
    // Antigravity's rewrite of it, and only differs when it rewrote something.
    toStringValue(toolCall.argumentsJson) ?? toStringValue(toolCall.originalArgumentsJson),
    toStringValue(mcpTool.resultString) ? `Result:\n${toStringValue(mcpTool.resultString)}` : undefined,
    toStringValue(error.shortError) ?? toStringValue(error.userErrorMessage),
  ].filter((line): line is string => Boolean(line));

  const content = sections.join("\n");
  return runtimeMessage(sessionId, timestamp, "tool", content, extractReferencedFiles(content), {
    stepType,
    toolName: qualifiedName ? `mcp:${qualifiedName}` : "mcp",
  });
}

function parseUserInputStep(
  sessionId: string,
  step: Record<string, unknown>,
  stepType: string,
  timestamp: Date,
): AntigravityRuntimeMessage | null {
  const userInput = isRecord(step.userInput) ? step.userInput : {};
  const content = toStringValue(userInput.userResponse);
  if (!content) {
    return null;
  }

  const activeUserState = isRecord(userInput.activeUserState) ? userInput.activeUserState : {};
  const activeDocument = isRecord(activeUserState.activeDocument)
    ? activeUserState.activeDocument
    : {};
  const activeFile = toStringValue(activeDocument.absoluteUri);
  const references = [...extractReferencedFiles(content), ...(activeFile ? [decodeFileUrl(activeFile)] : [])];

  return runtimeMessage(sessionId, timestamp, "user", content, references, {
    stepType,
    sourcePath: activeFile,
  });
}

function parsePlannerResponseStep(
  sessionId: string,
  step: Record<string, unknown>,
  stepType: string,
  timestamp: Date,
): AntigravityRuntimeMessage | null {
  const plannerResponse = isRecord(step.plannerResponse) ? step.plannerResponse : {};
  const content =
    toStringValue(plannerResponse.modifiedResponse) ?? toStringValue(plannerResponse.response);
  if (!content) {
    return null;
  }

  const metadata = isRecord(step.metadata) ? step.metadata : {};
  return runtimeMessage(sessionId, timestamp, "assistant", content, extractReferencedFiles(content), {
    stepType,
    model: toStringValue(metadata.generatorModel),
  });
}

function parseCodeActionStep(
  sessionId: string,
  step: Record<string, unknown>,
  stepType: string,
  timestamp: Date,
): AntigravityRuntimeMessage | null {
  const codeAction = isRecord(step.codeAction) ? step.codeAction : {};
  const description = toStringValue(codeAction.description);
  const actionResult = isRecord(codeAction.actionResult) ? codeAction.actionResult : {};
  const edit = isRecord(actionResult.edit) ? actionResult.edit : {};
  const actionSpec = isRecord(codeAction.actionSpec) ? codeAction.actionSpec : {};
  const createFile = isRecord(actionSpec.createFile) ? actionSpec.createFile : {};
  const filePath = toStringValue(edit.absoluteUri) ?? toStringValue(createFile.path);
  const diff = normalizeDiff(edit.diff);
  const artifactMetadata = isRecord(codeAction.artifactMetadata)
    ? codeAction.artifactMetadata
    : {};

  const sections = [
    filePath ? `[Code Edit] ${filePath}` : "[Code Edit]",
    description,
    toStringValue(artifactMetadata.summary),
    diff ? `Diff:\n${diff}` : undefined,
  ].filter((line): line is string => Boolean(line));
  const content = sections.join("\n");
  if (!content.trim()) {
    return null;
  }

  return runtimeMessage(sessionId, timestamp, "tool", content, referencesFromValues([content, filePath]), {
    stepType,
    toolName: "code_edit",
    sourcePath: filePath,
  });
}

function parseRunCommandStep(
  sessionId: string,
  step: Record<string, unknown>,
  stepType: string,
  timestamp: Date,
): AntigravityRuntimeMessage | null {
  const runCommand = isRecord(step.runCommand) ? step.runCommand : {};
  const command = toStringValue(runCommand.commandLine) ?? toStringValue(runCommand.command);
  if (!command) {
    return null;
  }

  const combinedOutput = isRecord(runCommand.combinedOutput) ? runCommand.combinedOutput : {};
  const sections = [
    `[Command] ${command}`,
    toStringValue(runCommand.cwd) ? `cwd: ${toStringValue(runCommand.cwd)}` : undefined,
    runCommand.exitCode !== undefined ? `exit_code: ${String(runCommand.exitCode)}` : undefined,
    toStringValue(combinedOutput.full) ? `Output:\n${toStringValue(combinedOutput.full)}` : undefined,
  ].filter((line): line is string => Boolean(line));

  return runtimeMessage(sessionId, timestamp, "tool", sections.join("\n"), referencesFromValues(sections), {
    stepType,
    toolName: "run_command",
    sourcePath: toStringValue(runCommand.cwd),
  });
}

function parsePathToolStep(
  sessionId: string,
  step: Record<string, unknown>,
  stepType: string,
  timestamp: Date,
  toolName: string,
  objectKey: string,
  fields: string[],
): AntigravityRuntimeMessage | null {
  const payload = isRecord(step[objectKey]) ? step[objectKey] : {};
  const value = firstStringField(payload, fields);
  if (!value) {
    return null;
  }

  return runtimeMessage(sessionId, timestamp, "tool", value, referencesFromValues([value]), {
    stepType,
    toolName,
    sourcePath: value,
  });
}

function parseSimpleToolStep(
  sessionId: string,
  step: Record<string, unknown>,
  stepType: string,
  timestamp: Date,
  toolName: string,
  objectKey: string,
  fields: string[],
): AntigravityRuntimeMessage | null {
  const payload = isRecord(step[objectKey]) ? step[objectKey] : {};
  const values = fields.map((field) => toStringValue(payload[field])).filter((value): value is string => Boolean(value));
  if (values.length === 0) {
    return null;
  }

  const content = values.join("\n");
  return runtimeMessage(sessionId, timestamp, "tool", content, referencesFromValues(values), {
    stepType,
    toolName,
  });
}

function runtimeMessage(
  sessionId: string,
  timestamp: Date,
  role: AntigravityChunk["role"],
  content: string,
  referencedFiles: string[],
  metadata: {
    stepType?: string;
    toolName?: string;
    sourcePath?: string;
    model?: string;
  },
): AntigravityRuntimeMessage {
  return {
    sessionId,
    timestamp,
    role,
    content,
    referencedFiles: [...new Set(referencedFiles.filter((value) => value.trim().length > 0))],
    stepType: metadata.stepType,
    toolName: metadata.toolName,
    sourcePath: metadata.sourcePath,
    model: metadata.model,
  };
}

/**
 * Endpoints that answered, and how many language server processes were there
 * to answer.
 *
 * The count is what separates "Antigravity is not running" from "Antigravity
 * is running and did not reply in time". Discovery probes each port with a
 * five-second call, and on a loaded machine that call times out — so an empty
 * endpoint list alone was read as "closed", the reader fell back to brain
 * artifacts, and the scan looked healthy while capturing almost nothing. That
 * is the exact case this reporting was added for, and it slipped through the
 * first version of the fix.
 */
interface AntigravityDiscovery {
  endpoints: AntigravityEndpoint[];
  processesFound: number;
}

/**
 * Why no endpoint answered, when that is worth reporting.
 *
 * Undefined means it is not: no language server process exists, so Antigravity
 * is closed, nothing has been lost, and warning would fire on every scan with
 * the app shut. A process that is running and did not answer is the opposite —
 * its transcripts are there and this scan cannot see them.
 *
 * Split out because this one branch is the whole distinction, and getting it
 * wrong is silent by construction: the first version of this fix only checked
 * the fetches and left discovery reading a slow server as a closed one.
 */
export function describeUnreachableServer(processesFound: number): string | undefined {
  return processesFound === 0
    ? undefined
    : `${processesFound} language server process(es) running but none answered discovery`;
}

/**
 * Whether a language server process is Antigravity's.
 *
 * `language_server*` matches Windsurf and Codeium too — the same binary family
 * from the same vendor. Probing theirs wastes a scan and, worse, reports a
 * degradation for an Antigravity that was never running.
 *
 * Antigravity's own process names itself in its arguments
 * (`--override_ide_name antigravity`, `--app_data_dir antigravity`, and an
 * install path ending in `Antigravity`), and the others do not. The store path
 * is deliberately not used: the server's arguments name the install, never the
 * transcript directory, so matching on that found nothing at all.
 */
function isAntigravityLanguageServer(commandLine: string): boolean {
  return commandLine.toLowerCase().includes("antigravity");
}

async function discoverLanguageServerEndpoints(): Promise<AntigravityDiscovery> {
  const processes = (await discoverLanguageServerProcesses()).filter((info) =>
    isAntigravityLanguageServer(info.commandLine),
  );
  const endpoints: AntigravityEndpoint[] = [];
  const seenPorts = new Set<number>();

  for (const processInfo of processes) {
    const ports = await findListeningPorts(processInfo.pid);
    for (const port of ports) {
      if (seenPorts.has(port)) {
        continue;
      }
      const response = await callLanguageServer(
        { port, csrf: processInfo.csrf, pid: processInfo.pid },
        "GetAllCascadeTrajectories",
        {},
        5_000,
      );
      if (response !== null) {
        endpoints.push({ port, csrf: processInfo.csrf, pid: processInfo.pid });
        seenPorts.add(port);
        break;
      }
    }
  }

  return { endpoints, processesFound: processes.length };
}

async function discoverLanguageServerProcesses(): Promise<AntigravityProcess[]> {
  return process.platform === "win32"
    ? discoverWindowsLanguageServerProcesses()
    : discoverPosixLanguageServerProcesses();
}

async function discoverWindowsLanguageServerProcesses(): Promise<AntigravityProcess[]> {
  try {
    const script = [
      "Get-CimInstance Win32_Process",
      "Where-Object { $_.Name -like 'language_server*' }",
      "Select-Object ProcessId, CommandLine",
      "ConvertTo-Json -Compress",
    ].join(" | ");
    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", script], {
      timeout: 15_000,
    });
    return parseProcessJson(String(stdout));
  } catch {
    return [];
  }
}

async function discoverPosixLanguageServerProcesses(): Promise<AntigravityProcess[]> {
  if (process.platform === "darwin") {
    return discoverMacLanguageServerProcesses();
  }

  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", "language_server"], {
      timeout: 5_000,
    });
    const pids = String(stdout)
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isFinite(pid) && pid > 0);

    const processes: AntigravityProcess[] = [];
    for (const pid of pids) {
      try {
        const cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
        const commandLine = cmdline.replace(/\0/g, " ");
        processes.push({ pid, csrf: extractCsrfToken(commandLine), commandLine });
      } catch {
        // Ignore read failures for exited processes
      }
    }
    return processes;
  } catch {
    return [];
  }
}

async function discoverMacLanguageServerProcesses(): Promise<AntigravityProcess[]> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", "language_server"], {
      timeout: 5_000,
    });
    const processes: AntigravityProcess[] = [];
    for (const pidText of String(stdout).split(/\r?\n/)) {
      const pid = Number(pidText.trim());
      if (!Number.isFinite(pid)) {
        continue;
      }
      try {
        const { stdout: commandLine } = await execFileAsync("ps", ["-p", String(pid), "-o", "args="], {
          timeout: 5_000,
        });
        processes.push({ pid, csrf: extractCsrfToken(String(commandLine)), commandLine: String(commandLine) });
      } catch {
        // Ignore processes that exit between pgrep and ps.
      }
    }
    return processes;
  } catch {
    return [];
  }
}

function parseProcessJson(raw: string): AntigravityProcess[] {
  if (!raw.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter(isRecord)
      .map((row) => {
        const pid = Number(row.ProcessId);
        const commandLine = toStringValue(row.CommandLine) ?? "";
        return Number.isFinite(pid)
          ? { pid, csrf: extractCsrfToken(commandLine), commandLine }
          : null;
      })
      .filter((value): value is AntigravityProcess => value !== null);
  } catch {
    return [];
  }
}

function extractCsrfToken(commandLine: string): string {
  return commandLine.match(/--csrf_token\s+(\S+)/)?.[1] ?? "";
}

async function findListeningPorts(pid: number): Promise<number[]> {
  return process.platform === "win32" ? findWindowsListeningPorts(pid) : findPosixListeningPorts(pid);
}

/**
 * Extract the ports a specific PID is listening on from `netstat -ano`.
 *
 * The PID is the last whitespace-separated column. Matching it with
 * `endsWith` treats PID 2140 as a match for PID 140, which would attribute
 * an unrelated process's port to the language server — and the CSRF token
 * is POSTed to whatever answers there. The column is compared exactly.
 */
export function parseWindowsListeningPorts(netstatOutput: string, pid: number): number[] {
  return netstatOutput
    .split(/\r?\n/)
    .filter((line) => {
      const columns = line.trim().split(/\s+/);
      return columns.includes("LISTENING") && columns[columns.length - 1] === String(pid);
    })
    .map((line) => line.match(/\s(?:127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d+)\s/)?.[1])
    .filter((value): value is string => value !== undefined)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
}

/** Extract listening ports from `lsof -Pan -p <pid> -iTCP -sTCP:LISTEN`. */
export function parsePosixListeningPorts(lsofOutput: string): number[] {
  return lsofOutput
    .split(/\r?\n/)
    .map((line) => line.match(/:(\d+)\s+\(LISTEN\)/)?.[1])
    .filter((value): value is string => value !== undefined)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
}

async function findWindowsListeningPorts(pid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("netstat", ["-ano"], { timeout: 10_000 });
    return parseWindowsListeningPorts(String(stdout), pid);
  } catch {
    return [];
  }
}

async function findPosixListeningPorts(pid: number): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-Pan", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"],
      { timeout: 10_000 },
    );
    return parsePosixListeningPorts(String(stdout));
  } catch {
    return [];
  }
}

async function callLanguageServer(
  endpoint: AntigravityEndpoint,
  method: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = httpsRequest(
      {
        // Loopback only, and the language server presents a self-signed
        // certificate there is no CA to validate against — so verification is
        // off by necessity, not convenience. The control that matters is
        // sending the CSRF token to the *right* process, which is why the
        // PID column is matched exactly (see parseWindowsListeningPorts).
        hostname: "127.0.0.1",
        port: endpoint.port,
        path: `/${LANGUAGE_SERVER_SERVICE}/${method}`,
        method: "POST",
        rejectUnauthorized: false,
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "Connect-Protocol-Version": "1",
          "X-Codeium-Csrf-Token": endpoint.csrf,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            resolve(null);
            return;
          }
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as unknown;
            resolve(isRecord(parsed) ? parsed : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
    req.write(body);
    req.end();
  });
}

/**
 * Session ids are taken from the conversation file names, and Antigravity
 * writes them in two formats: the original protobuf `.pb` and, since it
 * migrated, SQLite `.db`. Both name the file after the cascade id, which is
 * the only thing needed here — the transcript itself is fetched from the
 * language server, not read off disk.
 *
 * Reading only `.pb` silently skipped every session written after the
 * migration. It could not fail loudly: unknown files are simply not
 * enumerated, so the runtime is never asked about them and the sessions do
 * not appear.
 */
const CONVERSATION_EXTENSIONS = [".pb", ".db"];

export async function listConversationFileIds(conversationsDir: string): Promise<string[]> {
  const names = await listFileNames(conversationsDir);
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const name of names) {
    const extension = CONVERSATION_EXTENSIONS.find((candidate) => name.endsWith(candidate));
    if (!extension) {
      continue;
    }
    // A session can exist in both stores; it is still one session.
    const id = basename(name, extension);
    if (id.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }

  return ids;
}

function formatArtifactContent(artifact: AntigravityArtifact): string {
  const header = [
    `Antigravity artifact: ${artifact.artifactName}`,
    `Source: ${artifact.sourcePath}`,
    artifact.artifactType ? `Type: ${artifact.artifactType}` : undefined,
    artifact.summary ? `Summary: ${artifact.summary}` : undefined,
  ].filter((line): line is string => Boolean(line));

  return `${header.join("\n")}\n\n${artifact.body.trim()}`;
}

function artifactMatchesProject(
  artifact: AntigravityArtifact,
  projectRoot: string,
  antigravityRoot: string,
): boolean {
  const text = normalizeSearchText(
    [
      artifact.sourcePath,
      artifact.summary ?? "",
      artifact.body,
      ...artifact.referencedFiles,
    ].join("\n"),
  );
  return textMentionsProject(text, projectRoot, antigravityRoot);
}

function runtimeConversationMatchesProject(
  conversation: AntigravityRuntimeConversation,
  projectRoot: string,
  antigravityRoot: string,
): boolean {
  if (
    conversation.workspaces.some((workspace) =>
      textMentionsProject(workspace, projectRoot, antigravityRoot),
    )
  ) {
    return true;
  }

  // Path evidence only. A previous fallback attributed a conversation when
  // the project's directory name appeared as a word anywhere in the title or
  // message text, which handed another project's private transcript to this
  // one whenever it mentioned that word — any project called `core`, `docs`,
  // or `client` collected most of the machine. A conversation Antigravity
  // gives us no path for is not attributable, so it is excluded.
  return conversation.messages.some((message) =>
    textMentionsProject(
      [
        message.content,
        message.sourcePath ?? "",
        ...message.referencedFiles,
      ].join("\n"),
      projectRoot,
      antigravityRoot,
    ),
  );
}

/**
 * Whether text records a file belonging to this project.
 *
 * The project's own path is the real evidence. Antigravity additionally keeps
 * a copy of some projects under `<its own root>/playground/<name>`, and those
 * conversations belong to the project they mirror — but only when that
 * playground is *this* install's.
 *
 * Matching `/playground/<name>/` anywhere was a name match wearing a path's
 * clothes: a conversation naming
 * `c:/Users/Someone/.gemini/antigravity/playground/api/...` was filed under a
 * project at `D:/work/api` — different drive, different user account. Any two
 * projects sharing a basename cross-contaminated, which is the boundary
 * PRODUCT.md promises and the comment above this one already says was
 * supposed to have been removed.
 *
 * What remains: a playground directory inside this reader's own Antigravity
 * install, sharing the project's name, is still treated as the project. Two
 * same-named projects in one user's own playground would still collide — that
 * case is genuinely ambiguous from a path alone, and it is a far narrower
 * claim than "anywhere on the machine".
 */
export function textMentionsProject(
  value: string,
  projectRoot: string,
  antigravityRoot?: string,
): boolean {
  const text = normalizeSearchText(value);
  if (mentionsPathWithBoundary(text, normalizeSearchText(projectRoot))) {
    return true;
  }

  if (!antigravityRoot) {
    return false;
  }

  const playground = `${normalizeSearchText(antigravityRoot)}/playground/${normalizeSearchText(basename(projectRoot))}`;
  return text.includes(`${playground}/`) || text.endsWith(playground);
}

function extractWorkspaceUris(summary: Record<string, unknown>): string[] {
  const direct = extractWorkspaceUrisFromValue(summary.workspaces);
  if (direct.length > 0) {
    return direct;
  }

  const metadata = isRecord(summary.trajectoryMetadata) ? summary.trajectoryMetadata : {};
  return extractWorkspaceUrisFromValue(metadata.workspaces);
}

function extractWorkspaceUrisFromValue(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((workspace) => toStringValue(workspace.workspaceFolderAbsoluteUri))
    .filter((uri): uri is string => uri !== undefined);
}

function extractReferencedFiles(content: string): string[] {
  const matches = content.match(/file:\/\/\/[^\s)\]>"]+/g) ?? [];
  return [...new Set(matches.map(decodeFileUrl).filter((value) => value.length > 0))];
}

function referencesFromValues(values: Array<string | undefined>): string[] {
  return values.flatMap((value) => value ? extractReferencedFiles(value) : []);
}

function normalizeDiff(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim().length > 0 ? value : undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const unifiedDiff = isRecord(value.unifiedDiff) ? value.unifiedDiff : {};
  if (!Array.isArray(unifiedDiff.lines)) {
    return JSON.stringify(value);
  }

  const lines = unifiedDiff.lines
    .filter(isRecord)
    .map((line) => `${diffLinePrefix(toStringValue(line.type))}${toStringValue(line.text) ?? ""}`);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function diffLinePrefix(type?: string): string {
  switch (type) {
    case "UNIFIED_DIFF_LINE_TYPE_INSERT":
      return "+";
    case "UNIFIED_DIFF_LINE_TYPE_DELETE":
      return "-";
    default:
      return " ";
  }
}

function decodeFileUrl(value: string): string {
  try {
    return decodeURIComponent(value.replace(/^file:\/\/\//, ""));
  } catch {
    return value.replace(/^file:\/\/\//, "");
  }
}

function firstStringField(record: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const value = toStringValue(record[field]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function isReadableArtifactName(name: string): boolean {
  const extension = extname(name).toLowerCase();
  return (extension === ".md" || extension === ".txt") &&
    !name.endsWith(".metadata.json") &&
    !name.includes(".resolved");
}

async function artifactTimestamp(
  sourcePath: string,
  metadata: AntigravityArtifactMetadata,
): Promise<Date> {
  const fromMetadata = toDate(metadata.updatedAt);
  if (fromMetadata.getTime() > 0) {
    return fromMetadata;
  }

  try {
    return (await stat(sourcePath)).mtime;
  } catch {
    return new Date(0);
  }
}

async function readArtifactMetadata(path: string): Promise<AntigravityArtifactMetadata> {
  const raw = await readTextIfExists(path);
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      artifactType: toStringValue(parsed.artifactType),
      summary: toStringValue(parsed.summary),
      updatedAt: toStringValue(parsed.updatedAt),
      version: toStringValue(parsed.version),
    };
  } catch (err) {
    // The file is there and unreadable, which is not the same as absent: the
    // artifact keeps its content but loses its type, summary and timestamp,
    // and the timestamp is what decides whether an incremental scan sees it.
    recordDrift(SCRAPER_NAME, path, `artifact metadata is not valid JSON: ${(err as Error).message}`);
    return {};
  }
}

async function listDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name))
      .sort();
  } catch {
    return [];
  }
}

async function listFileNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Whether `text` records `path` as a whole path rather than as a prefix of a
 * longer one.
 *
 * A bare `includes` filed every sibling whose name merely starts with this
 * project's: a root of `h:/projects/app` matched `h:/projects/app-secret/…`
 * and `h:/projects/appendix/…`, handing their transcripts to this project.
 * That is the third time this comparison has leaked along the same edge — the
 * two comments above record a `<name>` word match and a `/playground/<name>/`
 * match — and each previous fix tightened the pattern without adding the
 * boundary the pattern needed.
 *
 * A match counts when the next character cannot continue the final path
 * segment: end of text, a `/`, or a delimiter. Anything a filename could
 * contain — a letter, digit, `-`, `.`, `_` — means this is a different
 * directory that happens to share a prefix.
 */
function mentionsPathWithBoundary(text: string, path: string): boolean {
  if (!path) {
    return false;
  }

  // Whitespace, quotes and brackets end a path in prose, JSON and stack
  // traces alike; the set is an allowlist so an unlisted character is treated
  // as a continuation and rejected.
  const DELIMITERS = new Set([" ", "\t", "\n", "\r", '"', "'", "`", ")", "]", "}", ">", ",", ";", "|"]);

  let from = 0;
  for (;;) {
    const at = text.indexOf(path, from);
    if (at === -1) {
      return false;
    }
    const next = text[at + path.length];
    if (next === undefined || next === "/" || DELIMITERS.has(next)) {
      return true;
    }
    from = at + 1;
  }
}

function normalizeSearchText(value: string): string {
  return safeDecode(value).replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/g, "").toLowerCase();
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function validDate(value: Date): Date | undefined {
  return value.getTime() > 0 && !Number.isNaN(value.getTime()) ? value : undefined;
}

function normalizeRole(value?: string): AntigravityChunk["role"] {
  switch (value) {
    case "user":
    case "assistant":
    case "system":
    case "tool":
      return value;
    default:
      return "assistant";
  }
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toPositiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function toMessageIndex(value: unknown): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return Math.floor(parsed);
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * End a degraded scan by throwing, after everything readable has been yielded.
 *
 * The chunks already yielded are kept — the index upserts as it goes — but the
 * index deliberately does not advance a scraper's cursor when its scan throws,
 * and that is the point. A degraded scan can fall back to a handful of recent
 * brain artifacts while the language server holds a thousand older messages;
 * advancing the cursor to those recent timestamps would put every one of those
 * messages permanently behind the cursor. Failing loudly also puts the reason
 * in `last_error`, which `xtctx status` shows.
 */
function failIfDegraded(degradation?: string): void {
  if (degradation) {
    throw new Error(`antigravity scan incomplete: ${degradation}`);
  }
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}

/**
 * Whether a step holds text a reader would have wanted.
 *
 * Used to decide whether an unhandled step type is worth reporting. Antigravity
 * emits bookkeeping steps that carry no conversation, and treating those as
 * drift would report ordinary operation as a format change. Text in the payload
 * means the opposite: something was there and this reader dropped it.
 *
 * Bookkeeping fields every step carries are excluded by name. `status` matters
 * most: it is a non-empty enum string on essentially every step, so counting it
 * made this answer "yes" for steps holding nothing at all — which turned any
 * new bookkeeping type into a false drift report, the very outcome this
 * predicate exists to avoid.
 */
const NON_CONTENT_STEP_FIELDS = new Set(["type", "metadata", "status"]);

function stepCarriesText(step: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(step)) {
    if (NON_CONTENT_STEP_FIELDS.has(key)) continue;
    if (containsNonEmptyString(value, 0)) return true;
  }
  return false;
}

function containsNonEmptyString(value: unknown, depth: number): boolean {
  // Bounded, but generously: a trajectory step is a protobuf message rather
  // than an arbitrary graph, and the observed ones nest six levels
  // (completedInteractions -> request -> askQuestion -> questions -> options ->
  // text). At four, real content went unseen and so unreported.
  if (depth > 8) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((item) => containsNonEmptyString(item, depth + 1));
  if (isRecord(value)) {
    return Object.values(value).some((item) => containsNonEmptyString(item, depth + 1));
  }
  return false;
}
