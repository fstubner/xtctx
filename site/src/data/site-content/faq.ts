import type { FaqItem, SectionCopy } from './types';

export const faqCopy: SectionCopy = {
  heading: 'Questions before using it in a repo',
  leadHtml: 'Short answers about setup, local storage, transcript limits, and what xtctx does not do.',
};

// `a` is plain text and goes into the FAQ structured data and /llms.txt;
// `aHtml` is the rendered version and may add links and <code>. Keep the two
// saying the same thing — a search result quoting the plain answer and a page
// showing a different one is the failure this pairing exists to avoid.
// Source has no FAQ groups; group left empty rather than inventing.
export const faq: FaqItem[] = [
  {
    group: '',
    q: 'What problem does xtctx solve?',
    a: 'It lets an AI coding tool read recent local transcript sessions from the current repo through MCP, including sessions from a different tool, so you can switch without re-explaining the work.',
  },
  {
    group: '',
    q: 'Do I need to run setup in every project?',
    a: 'Yes, once per project you want handoff in. The plugin makes the tools reachable everywhere, but a project that has not opted in has no index to read, so every tool answers with that and names `npx -y xtctx setup`. Setup also adds delivery: managed instruction blocks put the handoff in front of the next agent whether it calls a tool or not.',
  },
  {
    group: '',
    q: 'Does xtctx run a background service?',
    a: 'No. xtctx has no daemon, API server, dashboard, watcher, or web service. MCP retrieval calls update the local cache on demand.',
  },
  {
    group: '',
    q: 'Does xtctx sync skills?',
    a: 'The plugin ships the built-in xtctx-handoff skill. Setup additionally inventories compatible skills from connected tools and syncs selected project skills to each supported target in that tool’s native format.',
  },
  {
    group: '',
    q: 'Does it summarize sessions?',
    a: 'No. xtctx points agents to recent raw transcript messages. Those messages stay the source of truth.',
  },
  {
    group: '',
    q: 'What are the limits?',
    a: 'xtctx is local-only. Transcript formats can change upstream, semantic vectors are created lazily, and keyword fallback is expected when local vector generation is unavailable.',
  },
  {
    group: '',
    q: 'Can I test it without private transcripts?',
    a: 'Yes. The public demo smoke creates synthetic Claude Code and Codex transcript stores in a temporary project, then calls the built MCP server over stdio.',
    aHtml:
      'Yes. The <a href="https://github.com/fstubner/xtctx/blob/main/docs/demo.md">public demo smoke</a> creates synthetic Claude Code and Codex transcript stores in a temporary project, then calls the built MCP server over stdio.',
  },
  {
    group: '',
    q: 'Which tools are supported?',
    a: 'Claude Code, Cursor, Codex, GitHub Copilot, Google Antigravity, opencode, and GitHub Copilot CLI.',
  },
  {
    group: '',
    q: 'Where does data live?',
    a: 'Project config lives in .xtctx/config.yaml. The rebuildable SQLite cache lives in .xtctx/state/xtctx.db. Source transcripts stay in each tool storage location.',
  },
  {
    group: '',
    q: 'Is it open source?',
    a: 'Yes. xtctx is MIT licensed and published at github.com/fstubner/xtctx.',
    aHtml:
      'Yes. xtctx is MIT licensed and published at <a href="https://github.com/fstubner/xtctx">github.com/fstubner/xtctx</a>.',
  },
];
