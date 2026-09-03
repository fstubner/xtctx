import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { toDate } from "../base.js";
import { toStringValue } from "./parse.js";
import { type AntigravityArtifactMetadata, warnDrift } from "./shared.js";

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

export async function artifactTimestamp(
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

export async function readArtifactMetadata(path: string): Promise<AntigravityArtifactMetadata> {
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
    warnDrift(path, `artifact metadata is not valid JSON: ${(err as Error).message}`);
    return {};
  }
}

export async function listDirectories(path: string): Promise<string[]> {
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

export async function listFileNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

export async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

