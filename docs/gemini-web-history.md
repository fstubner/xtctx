# Gemini web-history pilot

Gemini website backfill is an experimental third provider in the existing Brave/Chrome extension. It imports text into the existing private web-history archive under `gemini-web`. It does not use the Gemini generation API or Gemini CLI files.

## Boundary and behavior

Only optional `https://gemini.google.com/*` access is added. The isolated reader makes same-origin, fixed read-only listing/detail RPC requests. CSRF tokens remain inside the injected reader; active account email is hashed for the extension checkpoint identity and is not returned. No cookie/profile database access or arbitrary URL fetching is added. The user supplies the intended account tab URL; its numeric /u/N/ selector (or numeric authuser parameter) is retained for the dedicated reader. Redirecting to a different account slot stops before reading history. Checkpoints and local archive source identities are namespaced by verified account hash. Changes during a run stop instead of mixing accounts. Provider-wide cooldowns remain shared across account slots.

Pagination uses opaque tokens with repeat checks; HTTP rate limits save cooldowns without automatic retries. Stable provider response/candidate IDs preserve revisions and alternative candidates. Array order does not establish inter-turn ancestry. A partial sweep resumes confirmed conversations; a completed sweep clears its per-sweep markers so a later pass can discover edits. Durable checkpoints advance only after native import and successful sync.

The initial parser preserves known prompt/response text and timestamps. Auxiliary fields, attachments, complete branch coverage, and account-wide discovery remain unverified. Hitting the 10,000-turn response cap refuses the conversation instead of silently shortening it. Gemini Takeout import and ongoing opened-page capture are not implemented.

## Live validation

Reload xtctx at brave://extensions, open website backfill, select Gemini (experimental), paste the Gemini tab URL after choosing the intended Google account, and grant only Gemini site access. Sign into Gemini in Brave first. Keep backfill and its dedicated reader tab open. Report fixed diagnostics or final counts, never tokens or raw RPC response bodies. A successful listing is not proof of account-wide coverage. Validate local/server source identities and full-byte text hashes after the pilot.

## Protocol references

Read-only RPC field positions were researched from primary adapter sources: https://github.com/egroup-labs/kept/blob/main/extension/platforms/gemini.js and https://github.com/EricAndrechek/gemini-usage/blob/main/_docs/GEMINI_API_INTERNALS.md. Active-account bootstrap research: https://github.com/pi-packages/nicobailon-pi-web-access/blob/main/gemini-web.ts. These are compatibility evidence, not an official or stable Google API contract. Google documents exports at https://support.google.com/gemini/answer/16920332.
