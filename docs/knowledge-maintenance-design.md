# Background knowledge maintenance

Status: proposed implementation design, 24 October 2026. No extraction worker is deployed. User-requested scope: asynchronous summaries, facts, insights, chronology, graphs and indexes, with readable provenance in xtctx. This extends the transcript product; it does not replace Agentbox or automatically change bot memory.

## Product contract

The archive remains the evidence. Derived knowledge helps people find and understand it, with links to original messages and an explicit distinction between quoted evidence, extracted assertions and model-generated interpretations. A worker must not silently turn a conversation claim into an established fact. The dashboard must show coverage, freshness, failures, extractor version and known omissions for every derived view.

Initial delivery order:
1. Readable source/capture metadata and a knowledge-job status surface.
2. Durable queue and deterministic chronological/source indexes, using synthetic tests.
3. Small, opt-in local-model summary/assertion pilot on recent sessions; evaluate factual fidelity before historical backfill.
4. Entity, topic, decision and task graph projections plus lexical/dense/hybrid retrieval of derivatives.
5. Incremental history backfill within measured CPU, memory, storage and inference budgets.

## Parts

Reuse the self-hosted SQLite store and one optional maintenance process. Do not introduce a graph database, Redis or an external queue initially. The HTTP process enqueues short transactional work; the maintenance process leases jobs and performs extraction outside database transactions. Existing transcript search and its vector sidecar retain their contracts. Graphs are projections over account-scoped entities and assertions, rather than a second source of truth.

## Boundaries

Source revisions -> durable job -> bounded extraction -> validated derivative -> searchable projection. Every stage is account-scoped. No model call occurs on the ingestion response path. Maintenance never modifies source messages, credentials, consent, schedules or bot instructions. Future model-assisted jobs require an explicitly configured inference endpoint and budget; no paid API fallback. Agentbox is one deployment, not a dependency.

## Proposed data model

- `knowledge_jobs`: account, job kind, source reference, exact input hash, extractor/prompt/schema versions, state, attempt count, lease owner/deadline, next eligible time, bounded error code, timestamps. Unique(account, kind, source reference, input hash, extractor version, prompt version, schema version). States: queued/running/succeeded/failed/cancelled. Expired leases can be reclaimed; completion checks the lease nonce and current input hash transactionally.
- `knowledge_artifacts`: account, kind (summary/insight/assertion), input manifest hash, text or validated structured payload, producing job, model/version, creation time, freshness and review status. Immutable revisions; current pointers replace destructive edits.
- `knowledge_evidence`: account, artifact, source message ID, exact content hash and optional Unicode character span. A source edit or deletion invalidates dependent artifacts and search entries before they can be returned as current. Multi-message summaries track every input, not just one convenient citation.
- `knowledge_entities`: account-scoped opaque identity, type and display label. Aliases are separate records; names alone never establish identity. Candidate merges require review, with reversible decisions and evidence.
- `knowledge_assertions`: account, artifact, subject entity, predicate, typed object, event start/end, event precision/timezone and whether inferred, source-statement time, ingestion time, processing time, status and optional conflict set. A missing event date means unknown, never now. Assertions may be proposed/confirmed/disputed/superseded/retracted. Model confidence is an uncalibrated estimate, distinct from human confirmation and evidence strength.
- `knowledge_review_events`: append-only account-owned corrections, confirmations and entity merge/reversal decisions. Corrections retain their evidence and cause dependent projections to rebuild.

Use foreign keys including account ownership where possible, check constraints for states/types, and unique idempotency keys. Index jobs by state/next eligibility/lease deadline; evidence by source ID/hash; artifacts by account/kind/freshness; assertions by account/entity/event time and conflict set. Keep source content out of job error logs. Additive migrations and resumable seeds precede any backfill; rollback disables workers and new reads without touching source archives.

## Chronology, graphs and retrieval

Offer separate event-time and conversation-time timelines, with unknown dates in an explicit bucket and date ranges displayed honestly. Do not sort an inferred event into a precise day. First graph views: entity relationships; project/topic links; decisions/tasks and their changes over time. Every edge opens its assertion and evidence. Label correlation/interpretation rather than implying causation.

Derivative keyword and vector indexes are separate from originals. Hybrid retrieval filters account/project scope before candidate selection and revalidates source hashes/freshness afterwards. Search indicates whether a hit is original text, a summary or an assertion. Original-only search remains available. Do not mix generated summaries into original-message counts or use a summary as evidence for another summary without retaining the original evidence chain.

## Resource and failure policy

Start disabled, concurrency one, low process priority, bounded batch sizes and capped output length. Configure explicit daily inference tokens/time, memory ceiling, minimum free disk and quiet periods. Pause inference during conversational load and benchmarking; an idle GPU alone is insufficient authorization to consume the production model. CPU-only indexing is separately budgeted. Measure queue delay, job duration, source coverage, tokens, peak memory and disk growth before selecting production limits. Agentbox currently has limited free disk, so no bulk model downloads or full-history extraction yet.

Retry only transient errors with bounded exponential backoff; terminal schema errors enter failed state for inspection. Never save partial model output as a successful fact extraction. Pause/resume/cancel operate through authenticated administrative controls with audit events. Lease expiry and crash recovery must not duplicate accepted artifacts. Account deletion removes derivatives, evidence, jobs, graph projections and vectors; source deletion invalidates both directly and transitively derived material.

## Trust

All transcripts and model output are untrusted data. Use schema-validated output, bounded fields and inert rendering. No extracted instruction can execute tools, contact people, modify facts as confirmed, or change system policy. Preserve private-audience restrictions when bot retrieval is integrated; a shared channel must not receive private evidence merely because the server token can read it. Do not place credentials, raw attachments or secret-bearing URLs in metadata views.

## Acceptance evidence required

Synthetic tests cover account isolation, source edits/deletes during running jobs, stale lease completion, crash/retry idempotency, malformed extraction, conflicting assertions, unknown/inferred event times, reversible identity corrections, budget pause and cancellation. Pilot evaluation separately measures supported-claim precision, citation correctness, omitted contradictions, summary coverage and retrieval usefulness, using held-out sessions and human review. Performance checks compare chatbot latency with workers stopped and active. No claim of complete knowledge is permitted while source coverage or original attachments remain unknown.

## Open choices

Choose the local extraction model after the tllm quality/performance campaign; do not assume Nemotron support or superiority. Set actual scheduling and token budgets from a small measured pilot. Browser coverage receipts and original attachments are still ingestion gaps and must remain visible. Continuous fine-tuning is a later, separately evaluated feature; this design does not train on personal data.
