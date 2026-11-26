# Private web history (Brave pilot)

ChatGPT and Claude are the initial sources. These are separate from the coding-agent
scrapers. The browser capture is an opt-in pilot, not a claim of full web-history
coverage. Neither provider's private API nor login cookies are read.

## Backfill

You do not need to open individual conversations. In ChatGPT, use Settings >
Data controls > Export data. In Claude, use Settings > Privacy > Export data.
Download the account export from the emailed link and extract conversations.json.
ChatGPT exports can take up to seven days; both providers expire download links
24 hours after delivery. Keep exports local; do not paste them into a chat.

The extension captures subsequently opened pages only. It is not the backfill
mechanism. Importing an account export and capturing visible pages are separate
paths into the same archive; repeating identical imports does not add messages.


Official account exports supply historical conversations. The input is the extracted
`conversations.json`, not the ZIP. The importer currently caps a file at 128 MiB;
larger exports require splitting the JSON array into smaller valid arrays.

```powershell
node dist/src/cli/index.js import-web conversations.json --provider chatgpt --account personal --archive H:/projects/private/web-history --dry-run
node dist/src/cli/index.js import-web conversations.json --provider chatgpt --account personal --archive H:/projects/private/web-history --sync
```

Claude uses `--provider claude`. Account labels are fixed namespaces: two accounts
from the same provider need different labels. The configured bridge serves one label;
it cannot automatically detect an account switch in the browser.

Source: [ChatGPT export](https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data)
and [Claude export](https://support.claude.com/en/articles/9450526-export-your-claude-data).

## Browser path and security boundary

The unpacked MV3 extension is in `browser-extension/`. It requests optional access
only to `https://chatgpt.com/*` and `https://claude.ai/*`, independently enabled in
its popup. Its isolated content script reads visible conversation messages every
five seconds. Capture requires provider message IDs; unsupported markup fails rather
than inventing identities. Only top-level, visible conversation pages are captured.
Stable streaming completion and actual signed-in DOM behavior still need live tests.

The extension sends framed JSON to `io.xtctx.web_history`. It has no upload token,
provider cookie access, arbitrary network destination or remote-command capability.
The user-owned native host fixes the archive path/account at registration, validates
and bounds input, stores messages locally, and optionally uses existing xtctx sync
credentials and project consent. It creates no HTTP listener or scheduled service.
The Windows installer binds exactly one extension ID in `allowed_origins`, uses a
per-user registry key and supports `-WhatIf`. It does not change security policy.

```powershell
./browser-extension/install-native-windows.ps1 -ExtensionId <Brave-extension-ID> -ProjectRoot H:/projects/private/web-history -Account personal -Sync -WhatIf
```

Actual installation uses the same command without `-WhatIf`. The archive must already
have its own `.xtctx/config.yaml`; all coding sources should be disabled in that
archive. The private deployment uses a separate non-Git web-history directory.

## Fidelity and identity

Provider/account/conversation/message identity separates users and sources. Repeated
identical captures/imports add no rows; content changes are preserved as revisions.
ChatGPT export mapping parents retain alternate branches; a DOM snapshot contains
only the opened branch and is marked incomplete. A later full export can enrich
an identical captured message's timestamp and parent metadata without duplicating it
or letting a later partial capture downgrade it.

Rendered text can differ from export Markdown. Different rendered/export variants
are retained as versions with representation metadata; they are not proof that the
user edited the original message. Counts currently count stored versions, not unique
logical provider messages. Current generic retrieval can return multiple versions.
Missing DOM timestamps are explicitly inferred/unknown, never claimed as historical
provider timestamps. File/image contents are not downloaded; export non-text counts
are recorded. This pilot does not claim complete attachment, canvas, artifact or
unopened-chat ingestion, deletion mirroring, or automatic capture of hidden branches.

## Validation and remaining checks

Focused parser/framing/SQLite tests exercise account separation, branches, revisions,
partial-to-full enrichment, duplicate capture and error paths. A spawned native host
was exercised twice with synthetic input: one inserted message, then zero additions,
valid binary framing, remote sync disabled. No synthetic conversation was uploaded.

The initial whole-unit run used worker threads and exposed unsafe test isolation:
thread-local environment overrides did not redirect native `os.homedir()` calls.
It overwrote saved login metadata and added synthetic consent entries. The existing
protected Agentbox token restored login; a normal tllm sync succeeded. Exactly 29
synthetic entries were removed and all 46 original production consents retained.
`tests/setup.ts` now rejects worker threads before test modules execute. The corrected
forked run passed 1,035 tests with one skipped before the added extension fixtures.
Full repository CI, independent acceptance and signed-in Brave end-to-end capture
remain separate checks. Local capture and all-project semantic completeness cannot
be inferred from unit tests.

## Local chats outside projects

`xtctx scan --all-local --project <private-archive-directory>` explicitly scans
all sessions from enabled local coding sources, including sessions without a
workspace. The destination must already be configured. Disabled sources remain
disabled; the switch is not read from repository configuration and does not change
ordinary project-scoped searches. Machine collection has separate scraper cursors
so a previous project scan cannot hide sessions it skipped. Store this archive
outside Git. It includes project chats too: counts across overlapping archives
must not be summed as unique conversations. Existing sync requires separate
archive consent. Automatic ongoing collection is not enabled by this command.

## Experimental website backfill

Reload the unpacked extension, then select Start or resume website backfill in
its popup. Keep the backfill page and a signed-in provider tab open. The reader
requests listings and individual conversations without opening each chat. It
checks the provider account on every request, imports through the existing fixed
native host, and checkpoints only after a successful local import with no pending
sync. Pausing/closing retains checkpoints; restart re-enumerates listings and skips
unchanged timestamped conversations. A two-second delay separates detail requests.
Authentication failure, unsupported formats, oversized conversations, pending sync
and rate limits stop the run rather than silently skipping a conversation.

This is not yet live-validated. ChatGPT uses normal and archived listings; Claude
currently requires exactly one accessible organization. Mutable pagination, project
listing coverage and hidden branches need provider-specific live checks. Native
captures remain marked partial; attachments are not downloaded. Listing exhaustion
does not establish complete account history. Credentials remain in the signed-in
provider tab and are not stored in checkpoints or sent to the native host.


## Claude content preservation (extractor version 2)

Bulk backfill and JSON import share `src/web/claude-content.ts`. The browser copy
is generated with `node scripts/build-web-content.mjs` (also part of `npm run build`).
It preserves plain text, literal tool inputs, nested readable tool results,
artifact/code text, text documents and provider-extracted attachment text. Source
labels identify this as untrusted transcript content, never executable instructions.
No tool is executed and no attachment URL is followed during extraction.

Message metadata records observed, preserved and omitted block types, plus bounded
attachment descriptors. Original binary files, image/audio data, redacted content
and unsupported opaque payloads are not downloaded or reconstructed. Attachment
metadata is distinct from having the original file. Native validation rejects path
or URL injection in descriptors. Oversized optional descriptor lists have explicit
omission counts; remote descriptors yield to core provenance under the 4 KiB budget.

Resume revisits legacy Claude checkpoints automatically; extractor-version-2
checkpoints are skipped when the provider update timestamp is unchanged. Partial
imports do not advance a conversation checkpoint. Existing text revisions remain
stored, and same-content records gain richer metadata once without duplication or
downgrading full-export provenance. Raw stored-row totals can therefore differ from
logical provider-message counts; compare the current extraction version when
measuring recovered content, not the sum of all historical omission counters.

Existing bounds remain: 128 MiB website detail response, 20,000 messages per capture,
64 MiB serialized capture budget and 4 MiB native frames. Large captures stream
through an acknowledged native port; incomplete transfers are discarded without
advancing the conversation checkpoint. Messages retain their original identity. Tool-input JSON preservation
is capped at 512 KiB and extraction depth/node counts are bounded. Private-server
uploads negotiate the server text limit (64 MiB on the standalone server;
64 KiB on the default Cloudflare backend). Unsupported sizes fail without shortening
the original or advancing the sync checkpoint;
full local text does not imply full remote text for oversized individual messages.
Complete graph/attachment fidelity is not established by this extractor update.

Tool-use schema reference: https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls
Website-specific artifact and attachment shapes remain a compatibility surface,
validated with synthetic fixtures rather than an official website API contract.


## Listing receipts and ongoing capture

Successful backfill stores a browser-local coverage receipt alongside its existing
account/organization checkpoint (`bulk-<provider>[:<organization>]:coverage`). The receipt
contains provider/account scope, completion time, normal/archived listing counts,
reported totals, pagination count, total stability and run-local import/omission
counts. It explicitly leaves account-wide coverage and original-attachment download
unverified. No transcript bodies, credentials or attachment URLs are stored in it.
Failed and paused runs do not produce a completed receipt. Provider listing totals
cannot prove project-specific or other-organization completeness.

Opened-page capture preserves only visible text with stable provider message IDs.
It records unknown parent links as null; visible ordering does not prove a branch
relationship. Unchanged snapshots are suppressed and edited content remains a new
revision. Hidden/streaming pages are skipped. A snapshot exceeding the 2.5 MiB
opened-page budget produces a specific backfill diagnostic instead of silent
success. Website backfill uses the separate bounded large-message transport.
Previously enabled sites are restored on browser startup/extension updates only
while the corresponding site grant remains present. No new grant is requested by
startup restoration. Live Brave validation remains separate from mocked UI tests.

The current attachment descriptors preserve extracted text and selected metadata;
they do not establish a copy of the original file. A storage estimate requires
provider-supplied original sizes or a bounded download pilot. Redacted/opaque
provider blocks remain explicit omissions, never fabricated text.
