import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AntigravityChunk } from "../../types/scraper.js";
import { AbstractScraper, estimateTokens, toDate, toMessageIndex } from "../base.js";
import { withDriftReport } from "../drift-log.js";
import { formatArtifactContent, isReadableArtifactName } from "./artifacts.js";
import { artifactMatchesProject, runtimeConversationMatchesProject } from "./project-match.js";
import { AntigravityLanguageServerClient } from "./runtime-client.js";
import {
  type AntigravityArtifact,
  type AntigravityRuntimeClient,
  type AntigravityRuntimeListing,
  SCRAPER_NAME,
  warnDrift,
} from "./shared.js";
import {
  artifactTimestamp,
  listDirectories,
  listFileNames,
  pathIsDirectory,
  readArtifactMetadata,
  readTextIfExists,
} from "./store.js";
import {
  extractReferencedFiles,
  normalizeRole,
  toStringArray,
  toStringValue,
} from "./values.js";

export class AntigravityScraper extends AbstractScraper<AntigravityChunk> {
  readonly tool = SCRAPER_NAME;

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
      warnDrift(`antigravity-ls:${this.antigravityRoot}`, degradation);
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
      warnDrift(
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
      return await this.runtimeClient.listConversations(join(this.antigravityRoot, "conversations"));
    } catch (err) {
      // The listing threw rather than returning nothing, which is a failure to
      // read Antigravity — not evidence that Antigravity has nothing to read.
      return { conversations: [], degradation: `runtime listing failed: ${(err as Error).message}` };
    }
  }
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

