import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { AntigravityChunk } from "../types/scraper.js";
import { AbstractScraper, estimateTokens, toDate } from "./base.js";

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

export class AntigravityScraper extends AbstractScraper<AntigravityChunk> {
  readonly tool = "antigravity";

  constructor(
    private readonly antigravityRoot: string,
    stateDir: string,
    private readonly projectRoot?: string,
  ) {
    super(stateDir);
  }

  async detect(): Promise<boolean> {
    try {
      const target = await stat(this.antigravityRoot);
      if (!target.isDirectory()) {
        return false;
      }

      return (await pathIsDirectory(join(this.antigravityRoot, "brain"))) ||
        (await pathExists(join(this.antigravityRoot, "mcp_config.json"))) ||
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
    yield* this.readArtifacts(cutoff);
  }

  async *fullSync(): AsyncIterable<AntigravityChunk> {
    yield* this.readArtifacts(new Date(0));
  }

  parseRaw(raw: unknown): AntigravityChunk {
    const value = raw as Record<string, unknown>;
    const content = toStringValue(value.content) ?? "";
    return {
      tool: "antigravity",
      sessionId: toStringValue(value.sessionId) ?? "unknown",
      timestamp: toDate(value.timestamp),
      role: "assistant",
      content,
      metadata: {
        messageIndex: toMessageIndex(value.messageIndex),
        tokenEstimate: estimateTokens(content),
        referencedFiles: toStringArray(value.referencedFiles),
        artifactType: toStringValue(value.artifactType),
        artifactName: toStringValue(value.artifactName),
        summary: toStringValue(value.summary),
        sourcePath: toStringValue(value.sourcePath),
      },
    };
  }

  private async *readArtifacts(since: Date): AsyncIterable<AntigravityChunk> {
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

function extractReferencedFiles(content: string): string[] {
  const matches = content.match(/file:\/\/\/[^\s)\]>"]+/g) ?? [];
  return [...new Set(matches.map(decodeFileUrl).filter((value) => value.length > 0))];
}

function decodeFileUrl(value: string): string {
  try {
    return decodeURIComponent(value.replace(/^file:\/\/\//, ""));
  } catch {
    return value.replace(/^file:\/\/\//, "");
  }
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
  } catch {
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
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

function toStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
