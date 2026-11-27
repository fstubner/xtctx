import type { PrivacyCopy } from './privacy-types';

// Privacy policy and plain-English terms for xtctx (/privacy/), required for
// Hosted Sync and the Chrome Web Store listing.
export const privacyCopy: PrivacyCopy = {
  heading: 'Privacy and Terms',
  leadHtml:
    'xtctx runs locally by default with no analytics, ad trackers, or telemetry. Transcript text and repository items leave your device only through explicit opt-in paths you configure.',
  bodyHtml: `
<h2>What stays on your machine</h2>
<p>By default, the xtctx CLI reads session transcripts already stored by your local coding agents and indexes them into <code>.xtctx/state/xtctx.db</code> inside each project. Machine-wide settings live in <code>~/.xtctx/</code>.</p>
<p>For Google Antigravity, xtctx queries the local Antigravity process on <code>127.0.0.1</code> only.</p>

<h2>Opt-in network features</h2>
<p>Nothing leaves your machine unless you enable one of these features:</p>
<ul>
  <li><strong>Local semantic search.</strong> <code>xtctx embeddings enable</code> downloads an open-weight embedding model and runtime once from npm and Hugging Face so vector search runs locally afterward. <code>xtctx embeddings disable</code> removes them.</li>
  <li><strong>Remote embedding endpoint.</strong> If you configure a custom embedding endpoint in <code>.xtctx/config.yaml</code>, indexed chunks from that project are sent there to compute vectors.</li>
  <li><strong>GitHub Issues and PRs import.</strong> Running <code>xtctx import-github</code> reads repository issues, pull requests, and comments from <code>api.github.com</code> (using <code>GITHUB_TOKEN</code> if set). Only explicitly imported items enter your local project index.</li>
  <li><strong>Chrome browser extension (Web History).</strong> Using optional host permissions for ChatGPT, Claude, or Gemini web, the extension reads conversations only when you click Capture or run a manual backfill. In default Web Sync mode, redacted snapshots upload to the sync server URL you specify. Local Dev mode (optional <code>nativeMessaging</code> permission) passes snapshots only to the local native host on your computer.</li>
  <li><strong>Self-hosted cloud sync.</strong> Opted-in projects (via <code>xtctx sync enable</code> or the extension) upload redacted messages only to the sync server URL you configure, accessed with your authenticated GitHub identity over OAuth or scoped bearer tokens.</li>
</ul>

<h2>Client-side redaction (best effort)</h2>
<p>Before uploading from the CLI or browser extension to a remote sync server, xtctx runs client-side regex and structural patterns to mask high-confidence secrets (such as API tokens, private keys, and credentials) and optional PII (emails, phones, SSNs, and payment cards when enabled). Server-side ingestion applies a second secret-redaction pass as defense in depth. Automated redaction is best-effort and cannot guarantee detection of every custom or domain-specific secret.</p>

<h2>Billing (when enabled by a server operator)</h2>
<p>When a cloud sync server operator enables Stripe billing, checkout and plan management happen directly with Stripe. Payment card and billing details stay with Stripe; transcript content is never shared with Stripe.</p>

<h2>Deletion and control</h2>
<ul>
  <li>Delete individual synced sessions any time from the cloud dashboard session reader.</li>
  <li>Revoke CLI and extension tokens at any time, or delete your account and all stored sessions/coverage records on that sync server via <code>DELETE /api/me</code> or the dashboard.</li>
  <li>Disable or uninstall the Chrome extension or revoke its site permissions via <code>chrome://extensions</code> at any time.</li>
</ul>

<h2>This website</h2>
<p>xtctx.com is static HTML served from GitHub Pages via Cloudflare. It runs no analytics scripts and sets no tracking cookies. Optional client-side GitHub repo and npm download stats calls and UI preferences stay in your browser.</p>

<h2>Plain-English Terms (CLI and Extension)</h2>
<ul>
  <li><strong>License and ownership.</strong> The xtctx CLI, local indexers, Chrome extension, and self-hosted cloud server are open-source under the MIT license. You retain full ownership and responsibility for all code, transcripts, and imported GitHub items you sync.</li>
  <li><strong>No hosted SLA or warranty.</strong> Self-hosted deployments and the Chrome extension are provided "as is" without uptime guarantees. Keep local backups via <code>xtctx export</code>.</li>
</ul>

<h2>Contact</h2>
<p>Privacy or deletion questions: open an issue or contact the maintainer via <a href="https://github.com/fstubner/xtctx/issues">github.com/fstubner/xtctx/issues</a>.</p>
`,
};
