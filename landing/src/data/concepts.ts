export interface Concept {
  slug: string;
  name: string;
  shortName: string;
  description: string;
  headline: string;
  subhead: string;
  approach: string;
}

export const concepts: Concept[] = [
  {
    slug: 'boxed-product',
    name: 'Boxed blueprint product',
    shortName: 'Boxed',
    description: 'A contained product page with setup selection and blueprint proof.',
    headline: 'Move between coding agents without starting over',
    subhead:
      'Run setup in a repo, choose the project skills to sync, and xtctx writes the local MCP config and managed instructions the next tool needs.',
    approach: 'Best when the page should feel deliberate and productized while keeping the blueprint feel from the current root.',
  },
  {
    slug: 'v9-less-diagram',
    name: 'v9, less diagram',
    shortName: 'v9 Lite',
    description: 'The current v9 rhythm, but with a smaller diagram and tighter proof.',
    headline: 'Local context handoff for coding agents',
    subhead:
      'xtctx keeps the surface small: setup, status, disconnect, and five MCP tools for recent local transcript sessions.',
    approach: 'Best if the v9 page shape is right but the middle section should do less.',
  },
  {
    slug: 'cli-first',
    name: 'CLI-first landing',
    shortName: 'CLI First',
    description: 'A developer-native page led by the command and its output.',
    headline: 'Set up local transcript retrieval from the CLI',
    subhead:
      'Install nothing global. Run one command in the repo, then let MCP clients read recent local sessions on demand.',
    approach: 'Best if xtctx should feel like a serious open-source CLI rather than a product site.',
  },
  {
    slug: 'two-column-proof',
    name: 'Two-column proof',
    shortName: 'Proof',
    description: 'A split proof page showing what setup writes and what agents call.',
    headline: 'Project wiring for local agent handoff',
    subhead:
      'xtctx writes local project files and exposes raw transcript retrieval through a small MCP surface.',
    approach: 'Best if the page should make the product contract obvious in the first scroll.',
  },
  {
    slug: 'docs-hybrid',
    name: 'Docs-landing hybrid',
    shortName: 'Docs',
    description: 'An understated docs-like landing page with command-first sections.',
    headline: 'Local MCP setup for recent coding sessions',
    subhead:
      'A small CLI and MCP server for reading recent local transcript sessions from supported AI coding tools.',
    approach: 'Best if the public page should feel open-source, plain, and trustworthy.',
  },
];

export const conceptNav = [
  { href: '#how', label: 'How it works' },
  { href: '#features', label: 'Features' },
  { href: '#setup', label: 'Setup' },
  { href: '#faqs', label: 'FAQs' },
  { href: 'https://github.com/fstubner/xtctx', label: 'GitHub' },
];

export const conceptFeatures = [
  {
    label: 'Setup',
    title: 'Writes local config',
    body: '.xtctx/config.yaml, managed instruction blocks, MCP config, and selected skill targets.',
  },
  {
    label: 'MCP',
    title: 'Five retrieval tools',
    body: 'recent sessions, session detail, transcript search, continuity status, and handoff manifest.',
  },
  {
    label: 'Storage',
    title: 'Raw transcripts stay local',
    body: 'SQLite is rebuildable cache state. Transcript files remain authoritative.',
  },
  {
    label: 'Limits',
    title: 'No background service',
    body: 'No daemon, dashboard, API server, durable memory, or generated summary layer.',
  },
];

export const setupLines = [
  'updated .xtctx/config.yaml',
  'updated .xtctx/skills/xtctx-handoff/SKILL.md',
  'updated AGENTS.md',
  'updated .codex/config.toml',
  'ready MCP config',
];

export const statusLines = [
  'ready mcp command npx -y xtctx',
  'ready managed instructions repaired',
  'ready 3 selected skills synced',
  'cache indexes on MCP retrieval',
  'data raw transcripts stay authoritative',
];
