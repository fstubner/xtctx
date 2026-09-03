import type { ConversationChunk, ConversationScraper } from "../types/scraper.js";
import type { SessionSummary } from "./types.js";

/**
 * Literal search straight over the transcript stores, with no index.
 *
 * Every other mode reads `retrieval_units`, so every other mode is only as
 * good as the last scan. That is the wrong dependency for the question this
 * answers — "was this ever discussed?" — at the one moment it is asked most:
 * the first session after another tool worked here, when the scan has not
 * finished. Measured against a 19GB Codex store a full scan is about ten
 * seconds; a literal pass can answer from the first matching file and stop.
 *
 * Agents already do this by hand. Two live trials ended with Claude Code
 * grepping `~/.codex/sessions` itself after the tools returned nothing useful,
 * and getting the right answer that way. This is that route, made a first-class
 * one — with the part the hand-rolled version skips: attribution.
 *
 * Attribution is why this streams `fullSync()` rather than reading files
 * directly. A grep over a store returns every project's transcripts, which is
 * the boundary this project has spent the most effort closing. Each scraper
 * already decides what belongs to this project, so the literal pass filters
 * what a scraper yields rather than re-deriving it — the same rule, enforced
 * in one place.
 */

/** Stop conditions, so an unmatched query cannot walk the whole machine. */
export interface LiteralSearchBudget {
  /** Sessions to return. */
  limit: number;
  /** Wall-clock ceiling; the pass returns what it has when this passes. */
  budgetMs: number;
}

export interface LiteralSearchResult {
  sessions: SessionSummary[];
  /**
   * Whether a stop condition ended the pass before every store was read.
   *
   * The caller has to say so. "No matches" and "no matches yet" are different
   * answers, and presenting the second as the first is the failure this
   * project keeps finding elsewhere.
   */
  exhausted: boolean;
}

/** Matches per session, mirroring the ranked modes' cap. */
const MAX_MATCHES_PER_SESSION = 3;

/** Characters of surrounding text kept with a hit. */
const MATCH_PREVIEW_CHARS = 240;

export async function literalSearch(
  tools: Array<{ tool: string; scraper: ConversationScraper }>,
  query: string,
  budget: LiteralSearchBudget,
  toolFilter?: string[],
): Promise<LiteralSearchResult> {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return { sessions: [], exhausted: true };
  }

  const wanted = new Set((toolFilter ?? []).map((tool) => tool.toLowerCase()));
  const selected = wanted.size > 0 ? tools.filter((t) => wanted.has(t.tool.toLowerCase())) : tools;
  const deadline = Date.now() + budget.budgetMs;
  const sessions = new Map<string, SessionSummary>();
  let exhausted = true;

  for (const { scraper } of selected) {
    if (sessions.size >= budget.limit || Date.now() >= deadline) {
      exhausted = false;
      break;
    }

    try {
      for await (const chunk of scraper.fullSync()) {
        if (Date.now() >= deadline) {
          exhausted = false;
          break;
        }

        if (!chunk.content.toLowerCase().includes(needle)) {
          continue;
        }

        const ref = `${chunk.tool}:${chunk.sessionId}`;
        const existing = sessions.get(ref);
        if (!existing) {
          // A new session past the limit is where the pass stops being
          // complete; one more match for a session already found is not.
          if (sessions.size >= budget.limit) {
            exhausted = false;
            break;
          }
          sessions.set(ref, newSummary(ref, chunk, needle));
          continue;
        }

        addMatch(existing, chunk, needle);
      }
    } catch {
      // One unreadable store must not lose the matches already found in the
      // others. The scan path records the error against the tool; this one is
      // a read that can be repeated, so it stays silent and incomplete.
      exhausted = false;
    }
  }

  return { sessions: [...sessions.values()], exhausted };
}

function newSummary(ref: string, chunk: ConversationChunk, needle: string): SessionSummary {
  const timestamp = chunk.timestamp.toISOString();
  const summary: SessionSummary = {
    session_ref: ref,
    tool: chunk.tool,
    started_at: timestamp,
    last_activity_at: timestamp,
    // Unknown without reading the whole session, and this pass deliberately
    // does not. Zero would read as "an empty session", so the count is the
    // matches found rather than a number this route cannot know.
    message_count: 0,
    preview: excerpt(chunk.content, needle),
    retrieval: "literal",
    matches: [],
  };

  const sourcePath = (chunk.metadata as { sourcePath?: unknown }).sourcePath;
  if (typeof sourcePath === "string" && sourcePath.length > 0) {
    summary.source_path = sourcePath;
  }

  addMatch(summary, chunk, needle);
  return summary;
}

function addMatch(summary: SessionSummary, chunk: ConversationChunk, needle: string): void {
  const timestamp = chunk.timestamp.toISOString();
  if (timestamp < summary.started_at) summary.started_at = timestamp;
  if (timestamp > summary.last_activity_at) summary.last_activity_at = timestamp;
  summary.message_count = (summary.message_count ?? 0) + 1;

  const matches = summary.matches ?? [];
  if (matches.length >= MAX_MATCHES_PER_SESSION) {
    return;
  }

  const index = chunk.metadata.messageIndex;
  matches.push({
    // No retrieval unit exists for this hit — nothing was indexed. The id
    // names the message it came from so a caller can still cite it.
    unit_id: `${summary.session_ref}#${index}`,
    message_start_index: index,
    message_end_index: index,
    started_at: timestamp,
    ended_at: timestamp,
    preview: excerpt(chunk.content, needle),
  });
  summary.matches = matches;
}

/** The text around the hit, so a caller sees why the session came back. */
function excerpt(content: string, needle: string): string {
  const at = content.toLowerCase().indexOf(needle);
  if (at < 0) {
    return content.slice(0, MATCH_PREVIEW_CHARS);
  }

  const start = Math.max(0, at - Math.floor((MATCH_PREVIEW_CHARS - needle.length) / 2));
  const slice = content.slice(start, start + MATCH_PREVIEW_CHARS);
  return (start > 0 ? "…" : "") + slice + (start + MATCH_PREVIEW_CHARS < content.length ? "…" : "");
}
