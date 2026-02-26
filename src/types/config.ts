import type { CompactionConfig } from "./compaction.js";

export interface XtctxConfig {
  version: string;
  project: {
    name: string;
    root: string;
  };
  ingestion: {
    scrapers: ScraperConfig[];
    watchPaths: string[];
    pollIntervalMs: number;
    excludePatterns: string[];
  };
  compaction: CompactionConfig;
  search: {
    defaultMode: "hybrid" | "semantic" | "keyword";
    defaultDepth: "summary" | "detail" | "raw";
    defaultLimit: number;
  };
  domainTags: Record<string, string[]>;
  web: {
    port: number;
  };
  api: {
    security: {
      token: string | null;
      allowedOrigins: string[];
      allowLocalhostOrigins: boolean;
      rateLimitWindowMs: number;
      rateLimitMax: number;
    };
  };
}

export interface ScraperConfig {
  tool: string;
  enabled: boolean;
  customStorePath?: string;
}

export interface ToolSyncConfig {
  skills: string[];
  commands: string[];
  agents: string[];
  preferences: Record<string, unknown>;
}
