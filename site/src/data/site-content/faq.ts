import type { FaqItem, SectionCopy } from './types';

export const faqCopy: SectionCopy = {
  heading: 'Questions before using it in a repo',
  leadHtml: 'Short answers about setup, where data lives, and what xtctx does not do.',
};

// `a` is plain text and goes into the FAQ structured data and /llms.txt;
// `aHtml` is the rendered version and may add links and <code>. Keep the two
// saying the same thing.
export const faq: FaqItem[] = [
  {
    group: 'What it is',
    q: 'What problem does xtctx solve?',
    a: 'Switching coding agents mid-task usually means re-explaining the work. xtctx lets the next agent read the last one’s recent sessions in the same repo, over MCP.',
  },
  {
    group: 'What it is',
    q: 'Does it summarise sessions or keep a memory?',
    a: 'No. Agents read the raw transcript messages, which stay the source of truth. xtctx generates no summary and keeps no memory.',
  },
  {
    group: 'What it is',
    q: 'Which agents are supported?',
    a: 'Claude Code, Codex, Cursor, GitHub Copilot in VS Code, GitHub Copilot CLI, Google Antigravity, and opencode.',
  },
  {
    group: 'Setup',
    q: 'Do I need to run setup in every project?',
    a: 'Yes, once per project: run npx -y xtctx setup. The plugin makes the tools reachable everywhere, but a project that has not been set up has no index, and every tool says so.',
    aHtml:
      'Yes, once per project: run <code>npx -y xtctx setup</code>. The plugin makes the tools reachable everywhere, but a project that has not been set up has no index, and every tool says so.',
  },
  {
    group: 'Setup',
    q: 'Does xtctx run a background service?',
    a: 'Not for local handoff. Each MCP client starts its own xtctx stdio server when needed and exits when the client disconnects. If you opt into remote sync, you deploy the separate cloud server yourself.',
  },
  {
    group: 'Setup',
    q: 'Can I try it without my own transcripts?',
    a: 'Yes. The public demo smoke creates synthetic Claude Code and Codex transcripts in a temporary project, then calls the built MCP server over stdio.',
    aHtml:
      'Yes. The <a href="https://github.com/fstubner/xtctx/blob/main/docs/demo.md">public demo smoke</a> creates synthetic Claude Code and Codex transcripts in a temporary project, then calls the built MCP server over stdio.',
  },
  {
    group: 'Data',
    q: 'Where does data live?',
    a: 'Config is .xtctx/config.yaml and the index is .xtctx/state/xtctx.db, both in the project. Transcripts stay where each agent keeps them. Claude Code deletes transcripts older than 30 days by default, and then the index is the only copy of those sessions, so back it up with xtctx export.',
    aHtml:
      'Config is <code>.xtctx/config.yaml</code> and the index is <code>.xtctx/state/xtctx.db</code>, both in the project. Transcripts stay where each agent keeps them. Claude Code deletes transcripts older than 30 days by default, and then the index is the only copy of those sessions, so back it up with <code>xtctx export</code>.',
  },
  {
    group: 'Data',
    q: 'Does anything leave my machine?',
    a: 'Not by default. Search runs on this machine. Two opt-ins send transcript text elsewhere: a remote OpenAI-compatible embedding endpoint set in a project’s config, and cloud sync, which uploads an opted-in project only after you log in and enable sync. High-confidence secrets are redacted on your device before upload, with optional PII scrubbing in .xtctx/config.yaml.',
    aHtml:
      'Not by default. Search runs on this machine. Two opt-ins send transcript text elsewhere: a remote OpenAI-compatible embedding endpoint set in a project’s config, and <a href="https://github.com/fstubner/xtctx/blob/main/docs/cloud-sync.md">cloud sync</a>, which uploads an opted-in project only after you log in and enable sync. High-confidence secrets are redacted on your device before upload, with optional PII scrubbing in <code>.xtctx/config.yaml</code>.',
  },
  {
    group: 'Data',
    q: 'What are the limits?',
    a: 'Agents can change their transcript formats without notice, so xtctx reports records it does not recognise instead of guessing. Search is keyword-only until you add semantic search (xtctx embeddings enable, about 540 MB), and it falls back to keyword while vectors are missing.',
    aHtml:
      'Agents can change their transcript formats without notice, so xtctx reports records it does not recognise instead of guessing. Search is keyword-only until you add semantic search (<code>xtctx embeddings enable</code>, about 540 MB), and it falls back to keyword while vectors are missing.',
  },
  {
    group: 'Data',
    q: 'Is it open source?',
    a: 'Yes. xtctx is MIT licensed and published at github.com/fstubner/xtctx.',
    aHtml:
      'Yes. xtctx is MIT licensed and published at <a href="https://github.com/fstubner/xtctx">github.com/fstubner/xtctx</a>.',
  },
  {
    group: 'Cloud sync',
    q: 'How do I sync coding agent context across multiple machines?',
    a: 'Run xtctx login --sync-url followed by xtctx sync enable in the projects you choose. You can self-host the included cloud package with Docker Compose (Node 24 and PostgreSQL 17 with pgvector) under the MIT license, with secret redaction running on your device before upload. Managed cloud hosting is not live yet; request early-access updates at github.com/fstubner/xtctx/issues. See /privacy/ for details.',
    aHtml:
      'Run <code>xtctx login --sync-url</code> followed by <code>xtctx sync enable</code> in the projects you choose. You can self-host the included <a href="https://github.com/fstubner/xtctx/tree/main/cloud">cloud/</a> package with Docker Compose (Node 24 and PostgreSQL 17 with pgvector) under the MIT license, with secret redaction running on your device before upload. Managed cloud hosting is not live yet: <a href="https://github.com/fstubner/xtctx/issues/new?labels=enhancement&title=Managed+Cloud+Early+Access">request early-access updates</a>. See <a href="/privacy/">Privacy and Terms</a>.',
  },
  {
    group: 'Cloud sync',
    q: 'Can xtctx index ChatGPT, Claude web, or GitHub Issues and PRs?',
    a: 'Yes. Run xtctx import-github inside a project to index repository issues, pull requests, and comments locally, or xtctx import-web for ChatGPT and Claude export archives. An optional Chrome extension can also capture web chats on those sites and send redacted snapshots to your configured sync server or local native host.',
    aHtml:
      'Yes. Run <code>xtctx import-github</code> inside a project to index repository issues, pull requests, and comments locally, or <code>xtctx import-web</code> for ChatGPT and Claude export archives. An optional Chrome extension can also capture web chats on those sites and send redacted snapshots to your configured sync server or local native host.',
  },
];
