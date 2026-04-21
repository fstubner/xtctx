/**
 * Query derivation rules for the ranking eval harness.
 *
 * Each anchor chunk (decision / error-solution / gotcha / insight / convention / faq)
 * is turned into 3-5 queries with a declared expected behaviour:
 *   - "exact"      -> anchor should be top-1 (distinctive token pulled verbatim)
 *   - "paraphrase" -> anchor should be in top-5 (template-swapped phrasing)
 *   - "negation"   -> anchor should NOT be top-1 (ideally ranked low)
 *   - "cross"      -> cross-phrasing using a neighbouring category's vocabulary;
 *                     we only require that the anchor is retrievable in top-10
 *                     (coarse recall), not that it's top-1
 *
 * All templates are deterministic functions of the anchor content. No LLM calls.
 */

import type { AnchorChunk, AnchorCategory } from "./corpus-generator.js";

export type QueryIntent = "exact" | "paraphrase" | "negation" | "cross";

export interface EvalQuery {
  /** Human-readable query text to feed into HybridSearch.search(). */
  text: string;
  /** The chunk ID the ranking layer is expected to surface. */
  expectedChunkId: string;
  /** Category of the anchor (for per-category metric breakdown). */
  category: AnchorCategory;
  /** How the query was derived — drives the assertion used. */
  intent: QueryIntent;
}

export function deriveQueries(anchor: AnchorChunk): EvalQuery[] {
  switch (anchor.category) {
    case "decision":
      return deriveDecisionQueries(anchor);
    case "error-solution":
      return deriveErrorSolutionQueries(anchor);
    case "gotcha":
      return deriveGotchaQueries(anchor);
    case "insight":
      return deriveInsightQueries(anchor);
    case "convention":
      return deriveConventionQueries(anchor);
    case "faq":
      return deriveFaqQueries(anchor);
  }
}

function deriveDecisionQueries(anchor: AnchorChunk): EvalQuery[] {
  const { technology_A, technology_B, rationale } = anchor.vars;
  return [
    {
      text: `${technology_A} ${rationale}`,
      expectedChunkId: anchor.chunkId,
      category: anchor.category,
      intent: "exact",
    },
    {
      text: `why did we pick ${technology_A} over ${technology_B}?`,
      expectedChunkId: anchor.chunkId,
      category: anchor.category,
      intent: "paraphrase",
    },
    {
      text: `what is the rationale for choosing ${technology_A}`,
      expectedChunkId: anchor.chunkId,
      category: anchor.category,
      intent: "paraphrase",
    },
    {
      text: `which option did we NOT pick between ${technology_A} and ${technology_B}`,
      expectedChunkId: anchor.chunkId,
      category: anchor.category,
      intent: "negation",
    },
  ];
}

function deriveErrorSolutionQueries(anchor: AnchorChunk): EvalQuery[] {
  const { error_message, command, fix } = anchor.vars;
  return [
    {
      text: error_message,
      expectedChunkId: anchor.chunkId,
      category: anchor.category,
      intent: "exact",
    },
    {
      text: `how to fix ${error_message}`,
      expectedChunkId: anchor.chunkId,
      category: anchor.category,
      intent: "paraphrase",
    },
    {
      text: `${command} fails with error`,
      expectedChunkId: anchor.chunkId,
      category: anchor.category,
      intent: "paraphrase",
    },
    {
      text: `what was the fix for ${error_message}`,
      expectedChunkId: anchor.chunkId,
      category: anchor.category,
      intent: "cross",
    },
    // Negation: we expect results that describe the *fix*, not the broken state.
    // Anchor still describes both, so it should remain retrievable — but top-1
    // ideally would be the fix language; we mark this "cross" rather than "negation".
    {
      text: `resolve ${fix}`,
      expectedChunkId: anchor.chunkId,
      category: anchor.category,
      intent: "cross",
    },
  ];
}

function deriveGotchaQueries(anchor: AnchorChunk): EvalQuery[] {
  const { subsystem, surprising_behavior, condition } = anchor.vars;
  return [
    {
      text: `${subsystem} ${surprising_behavior}`,
      expectedChunkId: anchor.chunkId,
      category: anchor.category,
      intent: "exact",
    },
    {
      text: `watch out for ${subsystem} when ${condition}`,
      expectedChunkId: anchor.chunkId,
      category: anchor.category,
      intent: "paraphrase",
    },
    {
      text: `what is surprising about ${subsystem}`,
      expectedChunkId: anchor.chunkId,
      category: anchor.category,
      intent: "paraphrase",
    },
    {
      text: `is ${subsystem} safe in ${condition}`,
      expectedChunkId: anchor.chunkId,
      category: anchor.category,
      intent: "cross",
    },
  ];
}

function deriveInsightQueries(anchor: AnchorChunk): EvalQuery[] {
  const { subsystem, insight } = anchor.vars;
  return [
    {
      text: `${subsystem} ${insight}`,
      expectedChunkId: anchor.chunkId,
      category: anchor.category,
      intent: "exact",
    },
    {
      text: `what did we learn about ${subsystem}`,
      expectedChunkId: anchor.chunkId,
      category: anchor.category,
      intent: "paraphrase",
    },
    {
      text: `insight on ${subsystem}`,
      expectedChunkId: anchor.chunkId,
      category: anchor.category,
      intent: "paraphrase",
    },
  ];
}

function deriveConventionQueries(anchor: AnchorChunk): EvalQuery[] {
  const { subsystem, convention } = anchor.vars;
  return [
    {
      text: `${subsystem} ${convention}`,
      expectedChunkId: anchor.chunkId,
      category: anchor.category,
      intent: "exact",
    },
    {
      text: `how do we name things in ${subsystem}`,
      expectedChunkId: anchor.chunkId,
      category: anchor.category,
      intent: "paraphrase",
    },
    {
      text: `project convention for ${subsystem}`,
      expectedChunkId: anchor.chunkId,
      category: anchor.category,
      intent: "paraphrase",
    },
  ];
}

function deriveFaqQueries(anchor: AnchorChunk): EvalQuery[] {
  const { question, answer } = anchor.vars;
  return [
    {
      text: question,
      expectedChunkId: anchor.chunkId,
      category: anchor.category,
      intent: "exact",
    },
    {
      text: `answer: ${answer}`,
      expectedChunkId: anchor.chunkId,
      category: anchor.category,
      intent: "paraphrase",
    },
    {
      text: question.replace(/\?$/, "").toLowerCase(),
      expectedChunkId: anchor.chunkId,
      category: anchor.category,
      intent: "paraphrase",
    },
  ];
}
