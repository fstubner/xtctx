import { checkDuplicate } from "../../knowledge/dedup.js";
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

export interface SimilarityMatch {
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

export function createWriteHandlers(
  writer: KnowledgeWriter,
  findSimilar?: SimilarityLookup,
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

    const id = createContextRecordId(title, body, "mcp");
    const record: ContextRecord = {
      id,
      type,
      created_at: new Date().toISOString(),
      supersedes: duplicate.action === "superseded" ? duplicate.existingId ?? undefined : undefined,
      source_tool: "mcp",
      referenced_files: [],
      domain_tags: [],
      environment: {},
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

  const saveDecision = async (params: SaveDecisionParams): Promise<WriteResult> => {
    const bodyParts = [params.rationale.trim()];
    if (params.context?.trim()) {
      bodyParts.push(`Context: ${params.context.trim()}`);
    }
    if (params.alternatives_considered?.length) {
      bodyParts.push(`Alternatives: ${params.alternatives_considered.join("; ")}`);
    }

    return write("decision", params.title.trim(), bodyParts.join("\n\n"), {
      rationale: params.rationale,
      context: params.context,
      alternatives_considered: params.alternatives_considered ?? [],
    });
  };

  const saveErrorSolution = async (
    params: SaveErrorSolutionParams,
  ): Promise<WriteResult> => {
    const title = params.error.trim();
    const bodyParts = [`Solution: ${params.solution.trim()}`];
    if (params.context?.trim()) {
      bodyParts.push(`Context: ${params.context.trim()}`);
    }

    return write("error_solution", title, bodyParts.join("\n\n"), {
      error: params.error,
      solution: params.solution,
      context: params.context,
    });
  };

  const saveInsight = async (params: SaveInsightParams): Promise<WriteResult> => {
    const title = params.insight.trim().slice(0, 80) || "Project insight";
    const body = params.context?.trim()
      ? `${params.insight.trim()}\n\nContext: ${params.context.trim()}`
      : params.insight.trim();

    return write("insight", title, body, {
      insight: params.insight,
      context: params.context,
    });
  };

  return {
    saveDecision,
    saveErrorSolution,
    saveInsight,
  };
}
