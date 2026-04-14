import { checkDuplicate } from "../../knowledge/dedup.js";
import type { AutoTagger } from "../../knowledge/tagger.js";
import {
  createContextRecordId,
  type ContextRecord,
  type ContextType,
  type WriteResult,
} from "../../types/context.js";

export interface KnowledgeWriter {
  save(record: ContextRecord): Promise<void>;
  supersede?(oldId: string, newId: string): Promise<void>;
}

interface SimilarityMatch {
  id: string;
  similarity: number;
}

export type SimilarityLookup = (
  type: ContextType,
  candidateText: string,
) => Promise<SimilarityMatch | null>;

export interface WriteHandlerDependencies {
  writer: KnowledgeWriter;
  findSimilar?: SimilarityLookup;
  autoTagger?: AutoTagger;
}

/** Validate that a required string field is present and non-empty. */
function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required field: ${field}`);
  }
  return value.trim();
}

/** Safely coerce an optional field to a string, returning undefined for absent values. */
function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : String(value);
}

/** Safely coerce an optional field to a string array, returning undefined for absent values. */
function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((v) => (typeof v === "string" ? v : String(v)));
}

export function createWriteHandlers(
  writer: KnowledgeWriter,
  findSimilar?: SimilarityLookup,
  autoTagger?: AutoTagger,
) {
  const write = async (
    type: ContextType,
    title: string,
    body: string,
    metadata?: Record<string, unknown>,
  ): Promise<WriteResult> => {
    const candidateText = `${title}\n${body}`;
    const similar = findSimilar ? await findSimilar(type, candidateText) : null;
    const duplicate = checkDuplicate(similar?.similarity ?? 0, similar?.id ?? null);

    if (duplicate.action === "duplicate_rejected") {
      return {
        action: "duplicate_rejected",
        id: similar?.id ?? "",
        replaced: similar?.id ?? undefined,
        message: "Similar record already exists; write rejected.",
      };
    }

    // Auto-enrich with file references, domain tags, and environment versions.
    const [referencedFiles, environment] = autoTagger
      ? await Promise.all([
          autoTagger.getFileReferences(candidateText),
          autoTagger.getEnvironment(),
        ])
      : [[], {}];
    const domainTags = autoTagger ? autoTagger.getDomainTags(candidateText) : [];

    const id = createContextRecordId(title, body, "mcp");
    const record: ContextRecord = {
      id,
      type,
      created_at: new Date().toISOString(),
      supersedes: duplicate.action === "superseded" ? duplicate.existingId ?? undefined : undefined,
      source_tool: "mcp",
      referenced_files: referencedFiles,
      domain_tags: domainTags,
      environment,
      title,
      body,
      metadata,
    };

    await writer.save(record);

    if (duplicate.action === "superseded" && duplicate.existingId && writer.supersede) {
      await writer.supersede(duplicate.existingId, id);
    }

    return {
      action: duplicate.action,
      id,
      replaced: duplicate.existingId ?? undefined,
    };
  };

  const saveDecision = async (raw: Record<string, unknown>): Promise<WriteResult> => {
    const title = requireString(raw.title, "title");
    const rationale = requireString(raw.rationale, "rationale");
    const context = optionalString(raw.context);
    const alternatives = optionalStringArray(raw.alternatives_considered);
    const bodyParts = [rationale];
    if (context?.trim()) {
      bodyParts.push(`Context: ${context.trim()}`);
    }
    if (alternatives?.length) {
      bodyParts.push(`Alternatives: ${alternatives.join("; ")}`);
    }

    return write("decision", title, bodyParts.join("\n\n"), {
      rationale,
      context,
      alternatives_considered: alternatives ?? [],
    });
  };

  const saveErrorSolution = async (raw: Record<string, unknown>): Promise<WriteResult> => {
    const title = requireString(raw.error, "error");
    const solution = requireString(raw.solution, "solution");
    const context = optionalString(raw.context);
    const bodyParts = [`Solution: ${solution}`];
    if (context?.trim()) {
      bodyParts.push(`Context: ${context.trim()}`);
    }

    return write("error_solution", title, bodyParts.join("\n\n"), {
      error: title,
      solution,
      context,
    });
  };

  const saveInsight = async (raw: Record<string, unknown>): Promise<WriteResult> => {
    const insight = requireString(raw.insight, "insight");
    const context = optionalString(raw.context);
    const title = insight.slice(0, 80) || "Project insight";
    const body = context?.trim()
      ? `${insight}\n\nContext: ${context.trim()}`
      : insight;

    return write("insight", title, body, {
      insight,
      context,
    });
  };

  const saveFaq = async (raw: Record<string, unknown>): Promise<WriteResult> => {
    const question = requireString(raw.question, "question");
    const answer = requireString(raw.answer, "answer");
    const context = optionalString(raw.context);
    const title = question.slice(0, 100) || "Project FAQ";
    const bodyParts = [`Q: ${question}`, `A: ${answer}`];

    if (context?.trim()) {
      bodyParts.push(`Context: ${context.trim()}`);
    }

    return write("faq", title, bodyParts.join("\n\n"), {
      question,
      answer,
      context,
    });
  };

  return {
    saveDecision,
    saveErrorSolution,
    saveInsight,
    saveFaq,
  };
}
