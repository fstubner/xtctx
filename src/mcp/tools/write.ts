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

interface SaveDecisionParams {
  title: string;
  rationale: string;
  context?: string;
  alternatives_considered?: string[];
}

interface SaveErrorSolutionParams {
  error: string;
  solution: string;
  context?: string;
}

interface SaveInsightParams {
  insight: string;
  context?: string;
}

interface SaveFaqParams {
  question: string;
  answer: string;
  context?: string;
}

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
    const params = raw as unknown as SaveDecisionParams;
    const title = requireString(params.title, "title");
    const rationale = requireString(params.rationale, "rationale");
    const bodyParts = [rationale];
    if (params.context?.trim()) {
      bodyParts.push(`Context: ${params.context.trim()}`);
    }
    if (params.alternatives_considered?.length) {
      bodyParts.push(`Alternatives: ${params.alternatives_considered.join("; ")}`);
    }

    return write("decision", title, bodyParts.join("\n\n"), {
      rationale: params.rationale,
      context: params.context,
      alternatives_considered: params.alternatives_considered ?? [],
    });
  };

  const saveErrorSolution = async (raw: Record<string, unknown>): Promise<WriteResult> => {
    const params = raw as unknown as SaveErrorSolutionParams;
    const title = requireString(params.error, "error");
    const solution = requireString(params.solution, "solution");
    const bodyParts = [`Solution: ${solution}`];
    if (params.context?.trim()) {
      bodyParts.push(`Context: ${params.context.trim()}`);
    }

    return write("error_solution", title, bodyParts.join("\n\n"), {
      error: params.error,
      solution: params.solution,
      context: params.context,
    });
  };

  const saveInsight = async (raw: Record<string, unknown>): Promise<WriteResult> => {
    const params = raw as unknown as SaveInsightParams;
    const insight = requireString(params.insight, "insight");
    const title = insight.slice(0, 80) || "Project insight";
    const body = params.context?.trim()
      ? `${insight}\n\nContext: ${params.context.trim()}`
      : insight;

    return write("insight", title, body, {
      insight: params.insight,
      context: params.context,
    });
  };

  const saveFaq = async (raw: Record<string, unknown>): Promise<WriteResult> => {
    const params = raw as unknown as SaveFaqParams;
    const question = requireString(params.question, "question");
    const answer = requireString(params.answer, "answer");
    const title = question.slice(0, 100) || "Project FAQ";
    const bodyParts = [`Q: ${question}`, `A: ${answer}`];

    if (params.context?.trim()) {
      bodyParts.push(`Context: ${params.context.trim()}`);
    }

    return write("faq", title, bodyParts.join("\n\n"), {
      question: params.question,
      answer: params.answer,
      context: params.context,
    });
  };

  return {
    saveDecision,
    saveErrorSolution,
    saveInsight,
    saveFaq,
  };
}
