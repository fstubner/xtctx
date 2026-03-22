import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { glob } from "glob";
import { classifyDomains, extractFileReferences } from "./autotag.js";

/** Auto-enrichment context injected into every knowledge save. */
export interface AutoTagger {
  getFileReferences(text: string): Promise<string[]>;
  getDomainTags(text: string): string[];
  getEnvironment(): Promise<Record<string, unknown>>;
}

const DEFAULT_DOMAIN_KEYWORDS: Record<string, string[]> = {
  auth: ["auth", "login", "oauth", "jwt", "token", "session", "password", "credential"],
  database: ["database", "sql", "migration", "schema", "query", "postgres", "sqlite", "mongo"],
  cicd: ["ci", "cd", "pipeline", "deploy", "github actions", "workflow", "build"],
  testing: ["test", "spec", "assert", "mock", "stub", "coverage", "vitest", "jest"],
  api: ["endpoint", "route", "rest", "graphql", "api", "request", "response"],
  frontend: ["component", "css", "html", "vue", "react", "ui", "layout", "style"],
  infra: ["docker", "kubernetes", "terraform", "aws", "cloud", "server", "container"],
  security: ["vulnerability", "xss", "injection", "cors", "csp", "helmet", "sanitize"],
};

export class ProjectAutoTagger implements AutoTagger {
  private repoFilesCache: string[] | null = null;
  private repoFilesCacheTime = 0;
  private static readonly CACHE_TTL_MS = 60_000;

  constructor(
    private readonly projectRoot: string,
    private readonly domainKeywords: Record<string, string[]>,
  ) {}

  async getFileReferences(text: string): Promise<string[]> {
    const files = await this.getRepoFiles();
    return extractFileReferences(text, files);
  }

  getDomainTags(text: string): string[] {
    const merged = { ...DEFAULT_DOMAIN_KEYWORDS, ...this.domainKeywords };
    return classifyDomains(text, merged);
  }

  async getEnvironment(): Promise<Record<string, unknown>> {
    const env: Record<string, unknown> = {
      os: process.platform,
    };

    try {
      const pkgRaw = await readFile(join(this.projectRoot, "package.json"), "utf-8");
      const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
      const deps = pkg.dependencies;
      if (deps && typeof deps === "object") {
        env.dependency_versions = deps;
      }
      const engines = pkg.engines;
      if (engines && typeof engines === "object") {
        env.runtime_versions = engines;
      }
    } catch {
      // No package.json or parse error — skip.
    }

    return env;
  }

  private async getRepoFiles(): Promise<string[]> {
    const now = Date.now();
    if (this.repoFilesCache && now - this.repoFilesCacheTime < ProjectAutoTagger.CACHE_TTL_MS) {
      return this.repoFilesCache;
    }

    try {
      const files = await glob("**/*", {
        cwd: this.projectRoot,
        nodir: true,
        ignore: ["node_modules/**", "dist/**", ".git/**", ".xtctx/.store/**"],
        maxDepth: 5,
      });
      this.repoFilesCache = files;
      this.repoFilesCacheTime = now;
      return files;
    } catch {
      return this.repoFilesCache ?? [];
    }
  }
}
