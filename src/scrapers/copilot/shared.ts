import { driftWarner } from "../base.js";

export const SCRAPER_NAME = "copilot";

/** Drift reporter bound to this scraper; every copilot module reports through it. */
export const warnDrift = driftWarner(SCRAPER_NAME);
