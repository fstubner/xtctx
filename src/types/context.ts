import { createHash } from "node:crypto";

export const CONTEXT_TYPES = [
  "decision",
  "error_solution",
  "insight",
  "convention",
  "gotcha",
] as const;

export type ContextType = (typeof CONTEXT_TYPES)[number];

export interface ContextRecord {
  id: string;
  type: ContextType;
  created_at: string;
  supersedes?: string;
  superseded_by?: string;
  source_tool: string;
  source_session?: string;
  referenced_files: string[];
  domain_tags: string[];
  environment: {
    runtime_versions?: Record<string, string>;
    dependency_versions?: Record<string, string>;
    os?: string;
    tool_version?: string;
  };
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
}

export type WriteAction = "created" | "superseded" | "duplicate_rejected";

export interface WriteResult {
  action: WriteAction;
  id: string;
  existing?: ContextRecord;
  replaced?: string;
  message?: string;
}

export function createContextRecordId(
  title: string,
  body: string,
  sourceTool: string,
): string {
  const hash = createHash("sha256");
  hash.update(`${title}|${body}|${sourceTool}`);
  return hash.digest("hex").slice(0, 16);
}

export function isValidContextType(type: string): type is ContextType {
  return CONTEXT_TYPES.includes(type as ContextType);
}
