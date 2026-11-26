# Local history collection and coverage

Local archives are explicit collection targets, separate from coding repositories. Machine-wide scans include projectless sessions from enabled supported stores. A configured project index alone does not establish machine-wide coverage.

## Three distinct checks

1. Discovery: source files/session identities and readable source records.
2. Indexing: records retained in the local archive, including historical records whose source files disappeared.
3. Upload: account-owned records stored on the selected remote server.

The dashboard's upload ledger identifies successful device/project uploads. Its source-coverage table contains collector-reported checks and their observation times. Unknown values remain null. A healthy source receipt is not an account-wide or whole-machine completeness guarantee; reports can become stale if collectors stop or credentials expire.

## Local scanner

`scan --all-local --project <archive>` disables per-project filtering only for that explicit archive and enabled sources. Machine archives are outside Git repositories and retain separate scan cursors. Ordinary project scanning is refused for an established machine archive. Collection does not require embeddings or GPU inference.

Supported source stores can be missing, unreadable, schema-incompatible or incomplete themselves. Cursor composer records with no turns are not conversations. References to missing composer records are coverage gaps. Antigravity's artifact fallback can miss user turns, while a successful live reader can provide them. Original binary attachments are a separate coverage dimension.

## Codex Desktop

Authoritative user events include both `user_message` and `item_completed/UserMessage`. Duplicate response-user packets can contain image data and injected context. Their exclusion alone does not establish missing user text.

For Desktop files without any authoritative user event, the reader retains response-user text with `sourceFormat=codex-desktop-response-user`, `mayIncludeInjectedContext=true` and a non-text-part count. That lane uses a bounded 32 MiB JSONL limit and does not ingest image binaries. A versioned replay repairs previously read files. A change from fallback to authoritative user events forces a replay, preserving deterministic indexing rather than adding both representations as duplicate user turns.

## Hermes import

`import-hermes <database> --namespace <device-profile> --archive <archive>` selects an explicit source database and profile namespace. Source SQLite is opened read-only and validated in a consistent transaction before archive writes. Main and worker profiles have different identities. The default Hermes home may differ from the gateway's actual active home.

Message source ID, role, timestamp, text, tool-call information, parent-session identity and channel provenance are retained. `session_meta` records map to system records with their original role in metadata. Model credentials and session model/system-prompt configuration are not copied. Unsupported identities, roles, timestamps and orphan messages fail validation. Separate reasoning fields and original attachments are not currently imported.

Repeated imports merge only new deterministic message IDs; edits create retained revisions. There is no lossy timestamp-only cursor. Each run rechecks the source snapshot and idempotently merges it, so interrupted imports are safe to retry. Empty sessions are retained locally. Import success does not establish upload success.

## Coverage receipt boundary

The standalone `/api/coverage` endpoint accepts bounded JSON from an authenticated device-bound collector token with `sync:write` scope. Account and device identity come from the verified token. The natural key is account/device/source; older observations cannot overwrite newer ones. Counts are nonnegative bounded integers or null, and notes are length-limited. Only account-authorized dashboard sessions can read these receipts. They are advisory observations, not commands or proof supplied by an independent attestor.

## Operational limits

Collector runs are bounded, avoid overlapping runs, and use existing account allowlists and HTTPS destinations. Expiring read/upload-only credentials do not authorize account deletion. Credential replacement does not invalidate an older backed-up token: current revocation is account-wide, so individual old credentials remain valid until expiry unless the account epoch is revoked.

The private deployment currently collects periodically on each remote host. The Windows task runs as the signed-in user without elevation or a stored password; it cannot promise uploads while the user is signed out. No PowerShell execution-policy reduction, public listener, Funnel exposure or model-service interruption is needed.
