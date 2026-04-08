import { Router } from "express";

export interface ContinuityRouterOptions {
  projectRoot: string;
}

export function createContinuityRouter(options: ContinuityRouterOptions): Router {
  const router = Router();

  // GET /api/continuity - retrieve continuity context
  router.get("/", async (req, res, next) => {
    try {
      // Future implementation: fetch continuity records from knowledge store
      res.json({
        continuity: [],
        projectRoot: options.projectRoot,
      });
    } catch (error) {
      next(error);
    }
  });

  // POST /api/continuity - save continuity records
  router.post("/", async (req, res, next) => {
    try {
      // Future implementation: persist continuity records
      const { records } = req.body as { records?: unknown[] };
      res.status(201).json({
        saved: records ? Array.isArray(records) ? records.length : 0 : 0,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
