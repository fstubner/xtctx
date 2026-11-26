import type { CloudContext } from "../types.js";
import { withUserDb } from "./pool.js";

export interface SearchOptions {
  query: string;
  mode: string;
  repoUrl?: string;
  limit: number;
}

export interface SearchMatch {
  message_id: string;
  session_ref: string;
  message_index: number;
  timestamp: string;
  role: string;
  repo_url: string;
  tool: string;
  excerpt: string;
  chunk_start: number;
}

export interface SearchCoverage {
  indexed_messages: number;
  total_messages: number;
  partial: boolean;
  update_tracking: string;
}

export interface SearchResponse {
  requested_mode: string;
  effective_mode: "keyword" | "semantic" | "hybrid";
  semantic_ready: boolean;
  coverage?: SearchCoverage;
  model?: string;
  fallback: string | null;
  matches: SearchMatch[];
}

/** Rank fusion avoids pretending tsvector rank and cosine distance share a scale. */
export function reciprocalRankFusion<T extends { message_id: string }>(lists: T[][], limit: number): T[] {
  const combined = new Map<string, { match: T; score: number }>();
  for (const list of lists) {
    const seen = new Set<string>();
    list.forEach((match, index) => {
      if (seen.has(match.message_id)) return;
      seen.add(match.message_id);
      const old = combined.get(match.message_id);
      combined.set(match.message_id, {
        match: old?.match ?? match,
        score: (old?.score ?? 0) + 1 / (60 + index + 1),
      });
    });
  }
  return [...combined.values()]
    .sort((a, b) => b.score - a.score || a.match.message_id.localeCompare(b.match.message_id))
    .slice(0, limit)
    .map((x) => x.match);
}

export function formatHalfVecLiteral(vec: number[]): string {
  if (vec.length === 0) throw new Error("Empty embedding vector");
  for (let i = 0; i < vec.length; i++) {
    if (!Number.isFinite(vec[i])) throw new Error("Non-finite embedding value");
  }
  return `[${vec.join(",")}]`;
}

export async function searchMessages(
  ctx: Pick<CloudContext, "pool" | "appRole" | "embedder">,
  userId: string,
  options: SearchOptions,
): Promise<SearchResponse> {
  if (
    !userId ||
    typeof options.query !== "string" ||
    !options.query.trim() ||
    options.query.length > 1000 ||
    !["keyword", "semantic", "hybrid"].includes(options.mode) ||
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 25 ||
    (options.repoUrl !== undefined && (typeof options.repoUrl !== "string" || options.repoUrl.length > 2000))
  ) {
    throw new Error("Invalid search arguments");
  }

  if (options.mode === "semantic" && !ctx.embedder) {
    throw new Error("Semantic indexing is not configured yet");
  }

  const terms = options.query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 32) ?? [];
  if (options.mode === "keyword" && terms.length === 0) {
    throw new Error("Query must contain searchable words");
  }

  const lexicalLimit = options.mode === "hybrid" ? 50 : options.limit;

  const lexicalMatches: SearchMatch[] =
    options.mode !== "semantic" && terms.length > 0
      ? await withUserDb(ctx, userId, async (client) => {
          const tsQueryText = terms.join(" ");
          const params: unknown[] = [tsQueryText, userId];
          let repoFilter = "";
          if (options.repoUrl) {
            params.push(options.repoUrl);
            repoFilter = `AND (s.repo_url = $${params.length} OR EXISTS (SELECT 1 FROM session_projects p WHERE p.session_ref = s.session_ref AND p.repo_url = $${params.length}))`;
          }
          params.push(lexicalLimit);

          const res = await client.query<{
            message_id: string;
            session_ref: string;
            message_index: number;
            timestamp: string;
            role: string;
            repo_url: string;
            tool: string;
            content_bytes: Buffer;
          }>(
            `SELECT m.id AS message_id, m.session_ref, m.message_index, m.timestamp, m.role,
                    s.repo_url, s.tool, m.content_bytes
             FROM messages m
             JOIN sessions s ON s.session_ref = m.session_ref
             CROSS JOIN plainto_tsquery('simple', $1) q
             WHERE m.user_id = $2
               AND s.user_id = $2
               AND m.search_tsv @@ q
               ${repoFilter}
             ORDER BY ts_rank_cd(m.search_tsv, q) DESC, m.timestamp DESC, m.id ASC
             LIMIT $${params.length}`,
            params,
          );

          return res.rows.map((row) => {
            const content = Buffer.from(row.content_bytes).toString("utf8");
            const lower = content.toLowerCase();
            const positions = terms.map((t) => lower.indexOf(t.toLowerCase())).filter((x) => x >= 0);
            const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 160);
            return {
              message_id: row.message_id,
              session_ref: row.session_ref,
              message_index: Number(row.message_index),
              timestamp: row.timestamp,
              role: row.role,
              repo_url: options.repoUrl ?? row.repo_url,
              tool: row.tool,
              excerpt: content.slice(start, start + 1200),
              chunk_start: start,
            };
          });
        })
      : [];

  let fallback: string | null = null;

  if (ctx.embedder && options.mode !== "keyword") {
    try {
      const [queryVector] = await ctx.embedder.embed([options.query]);
      const vecLiteral = formatHalfVecLiteral(queryVector);
      const model = ctx.embedder.model;
      const dims = ctx.embedder.dimensions;

      const { denseMatches, coverage } = await withUserDb(ctx, userId, async (client) => {
        await client.query("SET LOCAL hnsw.iterative_scan = relaxed_order");
        await client.query("SET LOCAL hnsw.ef_search = 80");

        const params: unknown[] = [vecLiteral, userId, model];
        let repoFilter = "";
        if (options.repoUrl) {
          params.push(options.repoUrl);
          repoFilter = `AND (s.repo_url = $${params.length} OR EXISTS (SELECT 1 FROM session_projects p WHERE p.session_ref = s.session_ref AND p.repo_url = $${params.length}))`;
        }

        // Over-fetch chunks cleanly before deduplicating by message_id.
        const chunkRes = await client.query<{
          message_id: string;
          session_ref: string;
          message_index: number;
          timestamp: string;
          role: string;
          repo_url: string;
          tool: string;
          chunk_start: number;
          content_bytes: Buffer;
        }>(
          `SELECT m.id AS message_id, m.session_ref, m.message_index, m.timestamp, m.role,
                  s.repo_url, s.tool, mc.chunk_start, m.content_bytes
           FROM message_chunks mc
           JOIN messages m ON m.id = mc.message_id
           JOIN sessions s ON s.session_ref = m.session_ref
           WHERE mc.user_id = $2
             AND s.user_id = $2
             AND mc.model = $3
             AND mc.content_sha256 = m.content_sha256
             ${repoFilter}
           ORDER BY mc.embedding <=> $1::halfvec(${dims}) ASC
           LIMIT 100`,
          params,
        );

        const covParams: unknown[] = [userId, model];
        let covRepoFilter = "";
        if (options.repoUrl) {
          covParams.push(options.repoUrl);
          covRepoFilter = `AND (s.repo_url = $${covParams.length} OR EXISTS (SELECT 1 FROM session_projects p WHERE p.session_ref = s.session_ref AND p.repo_url = $${covParams.length}))`;
        }

        const covRes = await client.query<{ total_messages: number; indexed_messages: number }>(
          `SELECT COUNT(DISTINCT m.id)::int AS total_messages,
                  COUNT(DISTINCT CASE WHEN mc.message_id IS NOT NULL THEN m.id END)::int AS indexed_messages
           FROM messages m
           JOIN sessions s ON s.session_ref = m.session_ref
           LEFT JOIN message_chunks mc
             ON mc.message_id = m.id
            AND mc.model = $2
            AND mc.content_sha256 = m.content_sha256
           WHERE m.user_id = $1 AND s.user_id = $1 ${covRepoFilter}`,
          covParams,
        );

        const covRow = covRes.rows[0] ?? { total_messages: 0, indexed_messages: 0 };
        const totalMessages = Number(covRow.total_messages ?? 0);
        const indexedMessages = Number(covRow.indexed_messages ?? 0);

        const seenMsgs = new Set<string>();
        const deduped: SearchMatch[] = [];
        for (const row of chunkRes.rows) {
          if (seenMsgs.has(row.message_id)) continue;
          seenMsgs.add(row.message_id);
          const content = Buffer.from(row.content_bytes).toString("utf8");
          const start = Math.max(0, Math.min(Number(row.chunk_start), content.length));
          deduped.push({
            message_id: row.message_id,
            session_ref: row.session_ref,
            message_index: Number(row.message_index),
            timestamp: row.timestamp,
            role: row.role,
            repo_url: options.repoUrl ?? row.repo_url,
            tool: row.tool,
            excerpt: content.slice(start, start + 1200),
            chunk_start: start,
          });
          if (deduped.length >= 50) break;
        }

        return {
          denseMatches: deduped,
          coverage: {
            indexed_messages: indexedMessages,
            total_messages: totalMessages,
            partial: indexedMessages < totalMessages,
            update_tracking: "postgres-queue",
          },
        };
      });

      // If no lexical terms existed and mode === 'hybrid', dense alone serves the query cleanly.
      const useHybrid = options.mode === "hybrid" && terms.length > 0;
      return {
        requested_mode: options.mode,
        effective_mode: useHybrid ? "hybrid" : "semantic",
        semantic_ready: true,
        coverage,
        model,
        fallback: null,
        matches: useHybrid
          ? reciprocalRankFusion([lexicalMatches, denseMatches], options.limit)
          : denseMatches.slice(0, options.limit),
      };
    } catch {
      if (options.mode === "semantic" || terms.length === 0) {
        throw new Error("Semantic search unavailable; retry later");
      }
      fallback = "Semantic worker unavailable; lexical results only";
    }
  }

  if (terms.length === 0) {
    throw new Error("Query must contain searchable words");
  }

  return {
    requested_mode: options.mode,
    effective_mode: "keyword",
    semantic_ready: false,
    fallback: options.mode === "hybrid" ? (fallback ?? "Semantic index not ready; lexical results only") : null,
    matches: lexicalMatches.slice(0, options.limit),
  };
}
