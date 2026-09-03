import { isRecord, toDate } from "../base.js";
import type { AntigravityChunk } from "../../types/scraper.js";
import { type AntigravityRuntimeMessage, warnDrift } from "./shared.js";
import { decodeFileUrl, extractReferencedFiles, toStringArray, toStringValue } from "./values.js";

/**
 * Antigravity trajectory steps to messages.
 *
 * One job: read what the language server sends for a session and turn the
 * steps this reader understands into transcript messages. The step-type sets
 * and the rename tally live here too — they are not separable bookkeeping, they
 * are how this reader knows whether its own extraction still matches what
 * Antigravity sends, and the tally is written inside the same loop.
 */

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
 * @internal Exported for tests only.
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
 * @internal Exported for tests only.
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
      warnDrift(location, `trajectory step is ${describeValue(step)}, not an object`);
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
      warnDrift(
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
      warnDrift(
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
      warnDrift(
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

function firstStringField(record: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const value = toStringValue(record[field]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function validDate(value: Date): Date | undefined {
  return value.getTime() > 0 && !Number.isNaN(value.getTime()) ? value : undefined;
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
