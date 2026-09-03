import { driftWarner } from "../base.js";
import type { AntigravityChunk } from "../../types/scraper.js";

export const SCRAPER_NAME = "antigravity";

/** Drift reporter bound to this scraper; every antigravity module reports through it. */
export const warnDrift = driftWarner(SCRAPER_NAME);

export interface AntigravityArtifactMetadata {
  artifactType?: string;
  summary?: string;
  updatedAt?: string;
  version?: string;
}

export interface AntigravityArtifact {
  sessionId: string;
  sourcePath: string;
  artifactName: string;
  artifactType?: string;
  summary?: string;
  timestamp: Date;
  body: string;
  referencedFiles: string[];
}

export interface AntigravityRuntimeMessage {
  sessionId: string;
  timestamp: Date;
  role: AntigravityChunk["role"];
  content: string;
  referencedFiles: string[];
  sourcePath?: string;
  stepType?: string;
  toolName?: string;
  model?: string;
}

export interface AntigravityRuntimeConversation {
  sessionId: string;
  title?: string;
  createdAt?: Date;
  workspaces: string[];
  messages: AntigravityRuntimeMessage[];
}

/**
 * What a runtime listing came back with, and whether it is the whole picture.
 *
 * A bare array means "this is everything" — the shape every existing caller and
 * test stub already returns. `degradation` is set when the language server was
 * there but could not be fully read: the transcripts exist, this scan just did
 * not get them. That difference decides whether the reader may advance its
 * incremental cursor, so it cannot be flattened into an empty array.
 */
export interface AntigravityRuntimeListing {
  conversations: AntigravityRuntimeConversation[];
  /** Human-readable reason the listing is incomplete, if it is. */
  degradation?: string;
}

export interface AntigravityRuntimeClient {
  listConversations(
    conversationsDir: string,
  ): Promise<AntigravityRuntimeConversation[] | AntigravityRuntimeListing>;
}

