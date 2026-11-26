# Web history ingestion and indexing review

Reviewed 2026-10-23. This is an implementation review, not complete account-coverage evidence.

## Observed coverage

The private local web archive held 44 ChatGPT conversations and 2,525 message
records at the coverage check, with 808 omitted non-text blocks and no Claude
sessions. These are archive counts, not the provider account total. Earlier
native-host failures and an empty-preview upload rejection interrupted backfill.
The reader enumerates normal/archived ChatGPT listings with pagination, but project
coverage and mutable-list reconciliation remain unverified. A completed listing
is not proof of a complete account export.

## Existing storage contract

Sessions identify provider/account/conversation through a hash, and messages identify
provider-message ID plus role/content revision. Metadata records the provider IDs,
parent, original role, inferred timestamps, partialness and non-text omission count.
The same stored messages feed derived keyword, semantic and hybrid retrieval units.
Identical imports deduplicate; content changes remain stored versions.

## Corrections applied during review

The sync metadata allowlist had removed web provenance, parent links, omission
counts and revision information. These fields now survive sanitization; credentials
and local paths remain excluded. Future API captures are labeled provider-api
instead of rendered-text and remain explicitly partial. The browser progress view
now reports each provider listing total/offset and cumulative saved checkpoints.
Existing stored/imported metadata is not retroactively inferred or rewritten.
Existing remote rows need a controlled re-upload to acquire previously stripped
metadata; an ordinary incremental sync is not proof that migration occurred.

## Required next contract

- Stable source identity: provider, account/workspace scope, source conversation ID,
  project membership (optional), source message ID, revision and capture version.
- Typed content blocks with text/code/tool/image/audio/file categories and explicit
  omitted/unsupported status; attachment references separated from payload storage.
- A conversation graph: parent/branch edges and active-branch information where
  supplied. Missing structure must remain unknown, never guessed from array order.
- Source timestamps separate from capture/import times and timestamp confidence.
- Ingestion manifest: run ID, scope, provider-reported total, discovered IDs,
  local/synced counts, failures and reasons, pagination/checkpoint state and recheck.
- Derived retrieval provenance: source revision, branch, extractor/chunker version,
  embedding model/version and references back to canonical messages/blocks.

## Remaining correctness gaps

Generic retrieval windows currently follow message order, not parent/branch edges;
mutually exclusive branches can therefore be combined into misleading context.
Stored versions are not yet consistently separated from canonical current logical
messages in retrieval and counts. Claude parent edges are currently reconstructed
as a chain, not verified against its full source graph. API and export captures
lack a complete typed-block model. Provider account identity is guarded in the
browser checkpoint but not a first-class remote account/workspace schema.

Do not claim complete history coverage, complete attachments, branch-faithful
retrieval, unique logical-message counts across overlapping archives, or completed
metadata migration until separately verified. Keep personal fine-tuning downstream
of this ingestion/quality work and the runner performance-validation campaign.
