import { Router } from "express";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { SessionService } from "../../mcp/tools/sessions.js";
import type { ContextRecord } from "../../types/context.js";

export interface SourcesRouteDependencies {
  projectRoot: string;
  knowledgeDir: string;
  stateDir: string;
  sessions: SessionService;
  knowledgeRecords: () => Promise<ContextRecord[]>;
}

export function createSourcesRouter(deps: SourcesRouteDependencies): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      const knowledge = await deps.knowledgeRecords();
      const claudeProjectsDir = resolveClaudeProjectsDir();
      const claudeDetected = await isDirectory(claudeProjectsDir);
      const recentSessions = await deps.sessions.listRecentSessions(5);

      res.json({
        projectRoot: deps.projectRoot,
        sources: [
          {
            name: "knowledge",
            kind: "filesystem",
            path: deps.knowledgeDir,
            records: knowledge.length,
          },
          {
            name: "claude-code",
            kind: "scraper",
            path: claudeProjectsDir,
            detected: claudeDetected,
          },
          {
            name: "scraper-state",
            kind: "filesystem",
            path: deps.stateDir,
          },
        ],
        sessions: recentSessions,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/status", async (_req, res, next) => {
    try {
      const claudeProjectsDir = resolveClaudeProjectsDir();
      const claudeDetected = await isDirectory(claudeProjectsDir);
      const records = await deps.knowledgeRecords();

      res.json({
        ok: true,
        claudeDetected,
        knowledgeRecords: records.length,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function resolveClaudeProjectsDir(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return join(home, ".claude", "projects");
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const result = await stat(path);
    return result.isDirectory();
  } catch {
    return false;
  }
}
