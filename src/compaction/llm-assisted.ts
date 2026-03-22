import type { CompactedSession, CompactionConfig } from "../types/compaction.js";
import type { ConversationChunk } from "../types/scraper.js";
import { CliCompactionProvider } from "./providers/cli.js";
import { compactChunksRuleBased } from "./rule-based.js";

const SUMMARIZE_PROMPT = `You are a session compactor for an AI coding tool. Given the raw conversation chunks below, produce a concise summary of what was accomplished, what decisions were made, and what questions remain open.

Reply ONLY with the summary text (2-4 sentences). No preamble, no markdown, no bullet points.

--- CHUNKS ---
`;

/**
 * LLM-assisted compaction: runs rule-based extraction first (for structure),
 * then shells out to an LLM CLI to produce higher-quality summaries.
 *
 * Falls back to rule-based summaries if the LLM call fails for any session.
 */
export async function compactChunksLlmAssisted(
  chunks: ConversationChunk[],
  config: CompactionConfig,
): Promise<CompactedSession[]> {
  // Step 1: Rule-based pass to get structure (tasks, decisions, files, etc.)
  const sessions = compactChunksRuleBased(chunks, {
    sessionBoundaryMinutes: config.sessionBoundaryMinutes,
  });

  if (!config.llm) {
    return sessions;
  }

  const provider = createProvider(config);
  if (!provider) {
    return sessions;
  }

  // Step 2: Group original chunks by session for LLM summarization
  const chunksBySession = groupChunksBySessions(chunks, sessions);

  // Step 3: Enhance each session's summary with LLM output
  const enhanced = await Promise.all(
    sessions.map(async (session, index) => {
      const sessionChunks = chunksBySession[index] ?? [];
      if (sessionChunks.length === 0) {
        return session;
      }

      try {
        const rawText = sessionChunks
          .map((c) => `[${c.role}] ${c.content}`)
          .join("\n\n");

        // Limit input to ~12k chars to avoid token limits on smaller models
        const truncated = rawText.length > 12_000
          ? rawText.slice(0, 12_000) + "\n[...truncated]"
          : rawText;

        const llmSummary = await provider.summarize(SUMMARIZE_PROMPT + truncated);
        if (llmSummary.trim().length > 0) {
          return { ...session, summary: llmSummary.trim() };
        }
      } catch {
        // Fall back to rule-based summary on any LLM failure
      }

      return session;
    }),
  );

  return enhanced;
}

function createProvider(config: CompactionConfig): LlmProvider | null {
  const llm = config.llm;
  if (!llm) {
    return null;
  }

  if (llm.provider === "cli") {
    const command = llm.command ?? "claude";
    const args = llm.args ?? ["--print"];
    return new CliCompactionProvider({ command, args, timeoutMs: 120_000 });
  }

  if (llm.provider === "ollama") {
    return new OllamaCompactionProvider(
      llm.model ?? "llama3.2",
      llm.endpoint ?? "http://localhost:11434",
    );
  }

  if (llm.provider === "openai") {
    const apiKeyEnv = llm.apiKeyEnv ?? "OPENAI_API_KEY";
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) {
      return null;
    }
    return new OpenAiCompactionProvider(
      llm.model ?? "gpt-4o-mini",
      llm.endpoint ?? "https://api.openai.com/v1/chat/completions",
      apiKey,
    );
  }

  return null;
}

interface LlmProvider {
  summarize(input: string): Promise<string>;
}

class OllamaCompactionProvider implements LlmProvider {
  constructor(
    private readonly model: string,
    private readonly endpoint: string,
  ) {}

  async summarize(input: string): Promise<string> {
    const response = await fetch(`${this.endpoint}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt: input, stream: false }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}: ${await response.text()}`);
    }

    const json = (await response.json()) as { response?: string };
    return json.response?.trim() ?? "";
  }
}

class OpenAiCompactionProvider implements LlmProvider {
  constructor(
    private readonly model: string,
    private readonly endpoint: string,
    private readonly apiKey: string,
  ) {}

  async summarize(input: string): Promise<string> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: input }],
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      throw new Error(`OpenAI returned ${response.status}: ${await response.text()}`);
    }

    const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content?.trim() ?? "";
  }
}

/**
 * Map each compacted session back to its original chunks by time range.
 * ConversationChunk doesn't carry a unique ID, so we match on the
 * session's time window.
 */
function groupChunksBySessions(
  chunks: ConversationChunk[],
  sessions: CompactedSession[],
): ConversationChunk[][] {
  return sessions.map((session) => {
    const start = new Date(session.timeRange.start).getTime();
    const end = new Date(session.timeRange.end).getTime();
    return chunks.filter((c) => {
      const t = c.timestamp.getTime();
      return t >= start && t <= end;
    });
  });
}
