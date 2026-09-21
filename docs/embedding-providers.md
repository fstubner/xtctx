# Embedding providers

Design for letting a project embed through an OpenAI-compatible endpoint
instead of the bundled local model. Nothing here is built yet.

## What stays true

xtctx ships local-only and stays local-only by default. The default MiniLM
model — downloaded on first use, not bundled in the package, which ships
`dist` only — is what runs when nobody configures anything, and that is the
behaviour
every existing claim describes.

An endpoint is opt-in, per project, and never inferred — no environment
variable that happens to be set, no auto-detection of a local server on a
well-known port. A project sends transcript text somewhere only because
someone wrote that endpoint into `.xtctx/config.yaml`.

The product claims need one clarification, not a retraction. "xtctx is
local-only. It does not upload transcripts or run telemetry" is true of what
xtctx does on its own and should say so:

> xtctx is local-only by default: it never uploads transcripts and runs no
> telemetry. A project can opt into an external embedding endpoint, in which
> case window text is sent there for vectorizing — `xtctx status` reports the
> endpoint whenever one is configured.

## Why anyone wants this

Two cases, and the local one is the stronger of the two.

**A local inference server.** Ollama and LM Studio both expose
`/v1/embeddings`, both keep everything on the machine, and both can use a GPU
that xtctx's in-process ONNX runtime is not currently using. Measured on this
machine, DirectML embedded the same segments about six times faster than the
CPU path and produced numerically identical vectors (mean cosine 1.000000
against CPU, worst pair 0.999999). An endpoint is one way to reach that
hardware without xtctx owning the GPU problem itself.

**A hosted model.** Better retrieval than a 22M-parameter model can give, for
someone who has already decided their transcripts may leave the machine.

## Interface

`EmbeddingProvider` already exists and `SqliteHandoffIndex` already takes one
by injection, so this is a second implementation rather than a new seam:

```ts
export interface EmbeddingProvider {
  readonly model: string;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  isReady?(): boolean;
  warm?(): void;
}
```

`OpenAiEmbeddingProvider` implements it against `POST {baseUrl}/embeddings`
with `{ model, input: string[] }`, reading `data[].embedding`. `isReady()` is
always true — there is no model to load — and `warm()` is a no-op, which
removes the warm-budget wait rather than needing a second code path for it.

## Configuration

```yaml
embedding:
  provider: openai-compatible     # default: "local"
  baseUrl: http://localhost:11434/v1
  model: nomic-embed-text
  apiKeyEnv: OLLAMA_API_KEY       # name of an env var, never the key itself
  batchSize: 32
  timeoutMs: 30000
  minSemanticCosine: 0.15         # see Thresholds
  minConfidentCosine: 0.36
```

`apiKeyEnv` names an environment variable. The key is never written to
`.xtctx/config.yaml`, which is a committable file — a project that carries one
would publish its own credential to everyone who clones the repository.

## Vector identity

`retrieval_unit_vectors` is keyed `(unit_id, model)`, and `initialize()` calls
`dropVectorsFromOtherModels` so changing model discards vectors built by the
previous one. That mechanism is correct and needs no change, but the value
stored in `model` does.

Two different services both serving `text-embedding-3-small` would share a
`model` value while producing vectors in different spaces — and a local
`nomic-embed-text` on two different runtimes may not agree either. The stored
identity therefore includes the endpoint:

```
openai:https://api.openai.com/v1:text-embedding-3-small
local:Xenova/all-MiniLM-L6-v2
```

Changing the endpoint or the model then invalidates vectors the same way
changing the local model already does. Dimensions then need no separate
handling — a different dimension count only ever arrives with a different
identity string, so the old vectors are already gone by the time the new ones
are written. That is a requirement on the identity string rather than
something the schema enforces: `retrieval_unit_vectors.dimensions` is stored
and nothing reads it back, so an identity that failed to change would mix
widths silently.

## Thresholds

This is the part most likely to be got wrong, and it was measured rather than
assumed. Bake-off on the 60-query eval corpus, 2026-09-20, each model first at
the thresholds tuned for MiniLM:

| model | hybrid mrr | recall@5 | top1 | false positives |
| --- | --- | --- | --- | --- |
| MiniLM (0.15/0.36) | 0.333 | 0.533 | 0.183 | 0 |
| bge-small | 0.395 | 0.550 | 0.267 | **1.00** |
| gte-small | 0.385 | 0.600 | 0.250 | **1.00** |

A false-positive rate of 1.00 means every deliberately unanswerable query,
gibberish included, returned something. The models are not worse — they place
their cosine values higher, and a floor tuned to MiniLM's distribution stops
excluding anything. Swept to their own thresholds, both are fine, and
bge-small at 0.55/0.65 beat MiniLM on every metric at a false-positive rate of
zero.

An unknown remote model has an unknown distribution, so it arrives in exactly
the state bge-small was in above: apparently working, quietly matching
everything. Therefore:

- `minSemanticCosine` and `minConfidentCosine` are configurable per provider,
  defaulting to today's values.
- `xtctx status` says when a non-local provider is running on unswept
  thresholds, because the failure is invisible from the outside — search keeps
  returning results, and they are wrong.

## Failure

A remote endpoint fails in ways a local model does not: connection refused,
401, 429, a timeout, a malformed body, a dimension that disagrees with what is
already stored.

All of them degrade to keyword search, which is the path a failed local model
already takes, and all of them record the reason in `embedding_error` so
`xtctx status` and `xtctx_continuity_status` report it. None of them fails a
`hybrid` tool call: an agent asking for context gets keyword results and a note
saying semantic search is unavailable, rather than an error. An explicit
`vector` request still throws, as it does today — there is no other route for
it to degrade to, and answering it from keyword would be answering a different
question than the one asked.

Retries are bounded and not clever — one retry on a 429 or a 5xx, then give up
for that call and let the next call try again. Vectorizing is already
incremental and resumable, so a failed pass costs a pass, not the index.

## Status surface

`xtctx status` and `xtctx_continuity_status` gain the provider line whenever
it is not the default:

```
Embed    openai-compatible http://localhost:11434/v1 (nomic-embed-text)
         thresholds unswept for this model — semantic matches may be noise
```

The endpoint is printed in full. "Am I sending my transcripts somewhere, and
where" should never require opening a config file.

Endpoint URLs go through the same untrusted-text handling as everything else
before reaching an agent's context, and an API key is never printed, even
partially.

## Out of scope

- Auto-detecting a local inference server. Opt-in means opt-in.
- Provider-specific SDKs. One HTTP call against a documented shape, no
  dependency.
- Re-embedding in the background on a provider change. The existing
  invalidate-and-refill path already handles it, slowly, which is the correct
  cost for a deliberate change.
- Embedding the query through one provider and the corpus through another.
  There is no sane use for it and it silently produces nonsense.

## Open questions

1. **Does a remote provider change the window size?** Windows are capped at 16
   segments because each is a separate forward pass locally. A remote batch
   endpoint has different economics, and the cap may be leaving recall on the
   table there. Needs measuring, not guessing.
2. **Should `scan --embed` behave differently against an endpoint?** It
   currently runs uncapped, which is right for local compute and possibly
   expensive against a metered API.
3. **Is a per-provider threshold sweep something xtctx can run itself?** The
   sweeps recorded in this repository were done by hand, against a temporarily
   patched constant; the eval harness runs one fixed provider and has no way to
   select a model or vary a threshold. A
   `xtctx calibrate` that sweeps against the project's own index would remove
   the unswept-threshold warning entirely, and is a larger piece of work than
   the provider itself.
