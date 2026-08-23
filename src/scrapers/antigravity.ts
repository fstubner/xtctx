import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { promisify } from "node:util";
import { basename, extname, join } from "node:path";
import type { AntigravityChunk } from "../types/scraper.js";
import { AbstractScraper, estimateTokens, toDate } from "./base.js";
import { recordDrift, withDriftReport } from "./drift-log.js";

const execFileAsync = promisify(execFile);
const SCRAPER_NAME = "antigravity";
const LANGUAGE_SERVER_SERVICE = "exa.language_server_pb.LanguageServerService";

/**
 * Step types this reader knows how to turn into a message.
 *
 * Kept beside `parseRuntimeStep` and checked against it by a test, because the
 * whole point of the drift report below is that this set says what "known"
 * means — a type handled there but missing here would be reported as drift on
 * every scan, and one listed here but silently dropped there would never be.
 */
/**
 * Step types Antigravity emits that this reader knowingly does not extract.
 *
 * Observed 2026-08-23 against a live language server, across 24 trajectories:
 * every one of these carries text, and together they account for roughly six
 * thousand dropped steps against the thousand this reader keeps. They are a
 * gap in coverage, not evidence that Antigravity changed anything, so they
 * must not be reported as drift — a warning that fires on every scan for a
 * known limitation is the crying-wolf failure this project has already made
 * once (`atis-latch`, 4ee257a).
 *
 * Listing them is what makes the drift check mean something: a type in neither
 * this set nor `HANDLED_STEP_TYPES` really is new.
 *
 * Whether any of these should be extracted instead is an open product
 * question — `ASK_QUESTION`, `INVOKE_SUBAGENT` and `MCP_TOOL` look like real
 * conversation; `CHECKPOINT` and `EPHEMERAL_MESSAGE` look like bookkeeping.
 */
export const KNOWN_UNHANDLED_STEP_TYPES = new Set([
  "CORTEX_STEP_TYPE_ASK_QUESTION",
  "CORTEX_STEP_TYPE_CHECKPOINT",
  "CORTEX_STEP_TYPE_CONVERSATION_HISTORY",
  "CORTEX_STEP_TYPE_EPHEMERAL_MESSAGE",
  "CORTEX_STEP_TYPE_ERROR_MESSAGE",
  "CORTEX_STEP_TYPE_GENERATE_IMAGE",
  "CORTEX_STEP_TYPE_GENERIC",
  "CORTEX_STEP_TYPE_GREP_SEARCH",
  "CORTEX_STEP_TYPE_INVOKE_SUBAGENT",
  "CORTEX_STEP_TYPE_KNOWLEDGE_ARTIFACTS",
  "CORTEX_STEP_TYPE_MCP_TOOL",
  "CORTEX_STEP_TYPE_SYSTEM_MESSAGE",
]);

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
}

export interface AntigravityRuntimeClient {
  listConversations(conversationsDir: string): Promise<AntigravityRuntimeConversation[]>;
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
    const runtimeChunks = await this.readRuntimeChunks(since);
    if (runtimeChunks.length > 0) {
      for (const chunk of runtimeChunks) {
        yield chunk;
      }
      return;
    }

    const brainDir = join(this.antigravityRoot, "brain");
    const sessionDirs = await listDirectories(brainDir);

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

      if (this.projectRoot && !artifactMatchesProject(candidate, this.projectRoot)) {
        continue;
      }

      artifacts.push(candidate);
    }

    return artifacts;
  }

  private async readRuntimeChunks(since: Date): Promise<AntigravityChunk[]> {
    const conversations = await this.safeListRuntimeConversations();
    const chunks: AntigravityChunk[] = [];

    for (const conversation of conversations) {
      if (this.projectRoot && !runtimeConversationMatchesProject(conversation, this.projectRoot)) {
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

    return chunks;
  }

  private async safeListRuntimeConversations(): Promise<AntigravityRuntimeConversation[]> {
    try {
      return await this.runtimeClient.listConversations(join(this.antigravityRoot, "conversations"));
    } catch {
      return [];
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
): boolean {
  if (!projectRoot) {
    return true;
  }

  const workspaces = extractWorkspaceUris(summary);
  if (workspaces.length === 0) {
    return true;
  }

  return workspaces.some((workspace) => textMentionsProject(workspace, projectRoot));
}

class AntigravityLanguageServerClient implements AntigravityRuntimeClient {
  constructor(private readonly projectRoot?: string) {}

  async listConversations(conversationsDir: string): Promise<AntigravityRuntimeConversation[]> {
    const endpoints = await discoverLanguageServerEndpoints();
    if (endpoints.length === 0) {
      return [];
    }

    const bySession = new Map<string, {
      endpoint: AntigravityEndpoint;
      summary: Record<string, unknown>;
    }>();

    for (const endpoint of endpoints) {
      const response = await callLanguageServer(endpoint, "GetAllCascadeTrajectories", {}, 5_000);
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
      shouldFetchTrajectory(entry.summary, this.projectRoot),
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
      if (Array.isArray(response?.steps)) {
        steps = response.steps;
      } else if (Array.isArray(response?.messages)) {
        steps = response.messages;
      } else if (response !== null) {
        // The server answered, but with neither field this reader knows. Every
        // message in the session is dropped, and without this it is dropped in
        // silence — indistinguishable from a session that is simply empty.
        recordDrift(
          SCRAPER_NAME,
          `antigravity-ls:${sessionId}`,
          `trajectory response has neither 'steps' nor 'messages' (keys: ${Object.keys(response).sort().join(", ") || "none"})`,
        );
      }
      const messages = parseAntigravityRuntimeSteps(sessionId, steps, entry.summary);
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

    return fetched.filter((entry): entry is AntigravityRuntimeConversation => entry !== null);
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

export function parseAntigravityRuntimeSteps(
  sessionId: string,
  steps: unknown[],
  summary: Record<string, unknown>,
): AntigravityRuntimeMessage[] {
  const fallbackTimestamp = toDate(summary.createdTime);
  const messages: AntigravityRuntimeMessage[] = [];
  // The transcript comes off the language server, not off disk, so the session
  // is the only location there is to point at.
  const location = `antigravity-ls:${sessionId}`;

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
      continue;
    }

    // An unhandled step type is only worth reporting when something was
    // actually lost. Antigravity's trajectories carry plenty of bookkeeping
    // steps that hold no conversation at all, and warning about those would
    // report normal operation as drift — the failure this project has already
    // made once, with `atis-latch`. A step whose payload holds text is a
    // different matter: that text was dropped.
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

  return messages;
}

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
    return parseSimpleToolStep(sessionId, step, stepType, timestamp, "find", "find", ["query"]);
  }
  if (stepType === "CORTEX_STEP_TYPE_LIST_DIRECTORY") {
    return parsePathToolStep(sessionId, step, stepType, timestamp, "list_dir", "listDirectory", [
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
  return null;
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

async function discoverLanguageServerEndpoints(): Promise<AntigravityEndpoint[]> {
  const processes = await discoverLanguageServerProcesses();
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

  return endpoints;
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
        processes.push({ pid, csrf: extractCsrfToken(commandLine) });
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
        processes.push({ pid, csrf: extractCsrfToken(String(commandLine)) });
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
          ? { pid, csrf: extractCsrfToken(commandLine) }
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

function artifactMatchesProject(artifact: AntigravityArtifact, projectRoot: string): boolean {
  const text = normalizeSearchText(
    [
      artifact.sourcePath,
      artifact.summary ?? "",
      artifact.body,
      ...artifact.referencedFiles,
    ].join("\n"),
  );
  const root = normalizeSearchText(projectRoot);
  const projectName = normalizeSearchText(basename(projectRoot));

  return text.includes(root) || text.includes(`/playground/${projectName}/`) ||
    text.endsWith(`/playground/${projectName}`);
}

function runtimeConversationMatchesProject(
  conversation: AntigravityRuntimeConversation,
  projectRoot: string,
): boolean {
  if (conversation.workspaces.some((workspace) => textMentionsProject(workspace, projectRoot))) {
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
    ),
  );
}

function textMentionsProject(value: string, projectRoot: string): boolean {
  const text = normalizeSearchText(value);
  const root = normalizeSearchText(projectRoot);
  const projectName = normalizeSearchText(basename(projectRoot));
  return text.includes(root) || text.includes(`/playground/${projectName}/`) ||
    text.endsWith(`/playground/${projectName}`);
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
 * `type` and `metadata` are excluded because every step has them; the payload
 * lives under a key named after the step.
 */
function stepCarriesText(step: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(step)) {
    if (key === "type" || key === "metadata") continue;
    if (containsNonEmptyString(value, 0)) return true;
  }
  return false;
}

function containsNonEmptyString(value: unknown, depth: number): boolean {
  // Bounded: a trajectory step is a protobuf message, not an arbitrary graph,
  // and an unbounded walk over one is a needless risk on every scan.
  if (depth > 4) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some((item) => containsNonEmptyString(item, depth + 1));
  if (isRecord(value)) {
    return Object.values(value).some((item) => containsNonEmptyString(item, depth + 1));
  }
  return false;
}
