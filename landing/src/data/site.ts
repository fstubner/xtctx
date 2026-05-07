// All project-specific content lives here. Fork the site and this is
// the one file you edit to retarget it at a different product. Every
// component reads from this module.

export interface Meta {
  /** Canonical site URL without trailing slash. */
  domain: string;
  /** <title> */
  title: string;
  /** <meta name="description"> */
  description: string;
  /** Short form used in OG / Twitter cards. Falls back to description. */
  ogDescription?: string;
  /** Comma-separated keyword list. */
  keywords: string;
  /** Site name for OG. */
  siteName: string;
  author: { name: string; url: string };
  /** Absolute URL to the OG/Twitter share image. */
  ogImage: string;
  /** Favicon + apple-touch-icon. */
  faviconPath: string;
  themeColor: string;
}

export interface Branding {
  /** Path to the wordmark image served from /. Optional — falls back to text. */
  wordmark?: string;
  /** Plain text wordmark. Used as alt text and as the fallback when no image is set. */
  wordmarkAlt: string;
  /** Links + underline accent colour. */
  accentGradient: string;
  /** Background fill. */
  bg: string;
  /** Default body text colour. */
  fg: string;
}

export interface Hero {
  /** Small uppercase strip above the headline. */
  badge: string;
  heading: string;
  subhead: string;
  /** Shell command shown in the hero's highlighted install block. */
  quickInstall: string;
  /** Jump-to-install link label. */
  installLinkLabel: string;
  /** Path to the hero screenshot. Optional. */
  heroImage?: string;
  heroImageAlt?: string;
  /** Intrinsic pixel dimensions so the browser reserves layout space. */
  heroImageWidth?: number;
  heroImageHeight?: number;
  /** Optional WebP source for <picture>. */
  heroImageWebp?: string;
  /** Link to the source repo for the "View source" pill. */
  sourceUrl: string;
}

export interface SurfaceCard {
  title: string;
  /** HTML allowed — typically short paragraph, may contain <code>. */
  body: string;
  /** If set, renders an image panel. */
  image?: {
    src: string;
    webp?: string;
    alt: string;
    width: number;
    height: number;
  };
  /** If set instead of image, renders a stylised code block. HTML allowed. */
  codeHtml?: string;
  /** If true, flips text and visual sides for alternating rhythm. */
  flip?: boolean;
}

export interface InstallEntry {
  label: string;
  /** Shell command(s) shown monospace with copy button. */
  command: string;
  /** Optional small hint under the command. HTML allowed. */
  hint?: string;
}

export interface FaqItem {
  q: string;
  /** Plain text used verbatim in both the visible section and JSON-LD. */
  a: string;
  /** Rich HTML variant for the visible section. Falls back to `a`. */
  aHtml?: string;
}

export interface BuiltWithEntry {
  name: string;
  url: string;
}

export interface SocialProof {
  /** GitHub repo in "owner/name" format. Used to fetch stars + download counts. */
  repo: string;
  /** If false, skip the live stars/downloads fetch in the hero. */
  showLiveStats?: boolean;
}

export interface Analytics {
  /** Cloudflare Web Analytics beacon token. Omit to disable. */
  cloudflareToken?: string;
}

export interface SectionCopy {
  heading: string;
  /** HTML allowed — typically short tagline with an anchor link. */
  leadHtml: string;
}

export interface SiteData {
  meta: Meta;
  branding: Branding;
  hero: Hero;
  /** Visible headings + leads for each main section. */
  copy: {
    surfaces: SectionCopy;
    install: SectionCopy;
    faq: SectionCopy;
  };
  surfaces: SurfaceCard[];
  install: {
    entries: InstallEntry[];
    tryCommands: string[];
    binariesNote: string;
  };
  faq: FaqItem[];
  builtWith: BuiltWithEntry[];
  social: SocialProof;
  analytics: Analytics;
  /** Version string used in structured data. */
  version: string;
}

const REPO = 'fstubner/xtctx';
const REPO_URL = `https://github.com/${REPO}`;

export const site: SiteData = {
  meta: {
    domain: 'https://xtctx.com',
    title:
      'xtctx — Cross-tool context continuity for AI coding agents',
    description:
      'xtctx is a local-first MCP server that indexes your conversations across Claude Code, Cursor, Copilot, Codex, and Gemini, then exposes hybrid search and structured project knowledge so you can switch tools mid-project without re-briefing the model.',
    ogDescription:
      'Local-first MCP server. Indexes conversation history across five AI coding tools. Resume work in any of them without losing context.',
    keywords:
      'mcp server, model context protocol, ai coding, claude code, cursor, github copilot, codex, gemini cli, conversation history, hybrid search, lancedb, bm25, vector search, local-first, cross-tool context, ai agent memory, continuity policy',
    siteName: 'xtctx',
    author: { name: 'Felix Stubner', url: 'https://github.com/fstubner' },
    ogImage: 'https://xtctx.com/favicon.svg',
    faviconPath: '/favicon.svg',
    themeColor: '#0a0c10',
  },

  branding: {
    wordmarkAlt: 'xtctx',
    // Single-color accent matching the global teal-300 (#5eead4). Kept as a
    // "gradient" string so existing components that consume it as a CSS value
    // still render correctly — solid color renders fine in `background:` too.
    accentGradient: '#5eead4',
    bg: '#0a0c10',
    fg: '#d6dbe1',
  },

  hero: {
    badge: 'Local-first · MIT · Node ≥20',
    // <em> styles to the teal accent via global.css. Keeps the verb in-color
    // so the headline reads "ACTION your project across tools."
    heading: 'Pick up your project in <em>any</em> AI coding tool.',
    subhead:
      'xtctx syncs project memory — decisions, error solutions, conventions, recent sessions — across Claude Code, Cursor, Copilot, Codex, and Gemini. Switch tools mid-task; resume where you left off without re-briefing the model.',
    quickInstall: 'npm install -g xtctx && xtctx init && xtctx serve',
    installLinkLabel: 'See install options',
    sourceUrl: REPO_URL,
  },

  copy: {
    surfaces: {
      heading: 'What it actually does',
      leadHtml:
        'Five tools, one project memory, one continuity policy. <a href="https://github.com/fstubner/xtctx#readme">Full README</a>',
    },
    install: {
      heading: 'Get started',
      leadHtml:
        'Install, init, serve — three commands. <a href="https://github.com/fstubner/xtctx#quick-start">Quick start</a>',
    },
    faq: {
      heading: 'FAQ',
      leadHtml: 'What people ask before installing.',
    },
  },

  surfaces: [
    {
      title: 'Resume — recall across tools via MCP',
      body:
        'xtctx serve runs an MCP server over stdio. Your assistant calls <code>xtctx_search</code> and <code>xtctx_project_knowledge</code> at session start to recall what you already decided, debugged, and shipped — regardless of which tool you used last week.',
      codeHtml: `<span style="color:#888">// session opener</span>
<span style="color:#7c9fc7">xtctx_search</span>(<span style="color:#8fbc7f">"auth error after last deploy"</span>)
<span style="color:#7c9fc7">xtctx_project_knowledge</span>({ <span style="color:#7c9fc7">type</span>: <span style="color:#8fbc7f">"all"</span> })

<span style="color:#888">// after coding</span>
<span style="color:#7c9fc7">xtctx_save_decision</span>({ title, rationale, alternatives_considered })
<span style="color:#7c9fc7">xtctx_save_error_solution</span>({ error, solution, context })`,
    },
    {
      title: 'Search — hybrid (BM25 + vector) over your own history',
      body:
        'Conversations and structured knowledge land in LanceDB. Queries fuse full-text and embedding similarity via Reciprocal Rank Fusion, with <code>hybrid</code>, <code>semantic</code>, and <code>keyword</code> modes selectable per call. The same pipeline backs the MCP recall tools and the <code>xtctx search</code> CLI.',
      flip: true,
      codeHtml: `<span style="color:#888">$</span> curl -s localhost:3232/api/search?q=lancedb+routing&mode=hybrid | jq '.[0]'
<span style="color:#555">{</span>
  <span style="color:#7c9fc7">"score"</span>:    0.91,
  <span style="color:#7c9fc7">"source"</span>:   <span style="color:#8fbc7f">"claude-code"</span>,
  <span style="color:#7c9fc7">"type"</span>:     <span style="color:#8fbc7f">"decision"</span>,
  <span style="color:#7c9fc7">"title"</span>:    <span style="color:#8fbc7f">"Route LanceDB writes through transaction guard"</span>,
  <span style="color:#7c9fc7">"snippet"</span>:  <span style="color:#8fbc7f">"...prevents partial-write corruption on..."</span>
<span style="color:#555">}</span>`,
    },
    {
      title: 'Sync — one continuity policy, rendered into every tool',
      body:
        'One <code>shared.yaml</code> declares the context feed, skills, commands, agents, MCP servers, slash commands, and whitelist policy you want present in every tool. <code>xtctx sync</code> renders that into Claude Code, Cursor, Copilot, Codex, and Gemini in their native formats. <code>xtctx serve</code> auto-reconciles drift on a timer.',
      codeHtml: `<span style="color:#888"># .xtctx/tool-config/shared.yaml</span>
<span style="color:#7c9fc7">scope</span>: project
<span style="color:#7c9fc7">context_feed</span>:
  session_opener: [xtctx_search, xtctx_project_knowledge]
  writeback_tools: [xtctx_save_decision, xtctx_save_error_solution]
<span style="color:#7c9fc7">mcp_servers</span>: [xtctx]
<span style="color:#7c9fc7">whitelist_policy</span>:
  advisory_level: warn`,
    },
    {
      title: 'Run — local-first, no SaaS, no telemetry',
      body:
        'Everything lives under <code>.xtctx/</code> in your repo and <code>~/.xtctx/</code> for the global baseline. Embeddings run in-process via <code>@xenova/transformers</code>; the index is LanceDB on disk. No telemetry, no cloud calls, no account. Your conversation history never leaves your machine.',
      flip: true,
      codeHtml: `<span style="color:#888">$</span> ls .xtctx/
config.yaml      knowledge/       lancedb/         tool-config/

<span style="color:#888">$</span> xtctx serve
<span style="color:#888">→</span> MCP   stdio
<span style="color:#888">→</span> API   http://127.0.0.1:3232/api
<span style="color:#888">→</span> Store .xtctx/lancedb/ (12,847 chunks, 4 tools)
<span style="color:#888">→</span> No outbound network calls.</span>`,
    },
  ],

  install: {
    entries: [
      {
        label: 'npm (global)',
        command: 'npm install -g xtctx',
        hint:
          'Requires Node ≥20. Installs the <code>xtctx</code> CLI on your PATH.',
      },
      {
        label: 'npx (no install)',
        command: 'npx xtctx init && npx xtctx serve',
        hint:
          'Try it without committing to a global install. Same binary, fetched on demand.',
      },
      {
        label: 'Bootstrap a project',
        command: 'xtctx init && xtctx sync && xtctx serve',
        hint:
          'Scaffolds <code>.xtctx/</code>, renders continuity blocks into your AI tools, then starts the MCP + API + runtime UI.',
      },
      {
        label: 'Full re-index',
        command: 'xtctx ingest --full',
        hint:
          'Rebuilds the LanceDB index from every conversation file the scrapers can find. Use after upgrading or after a long offline stretch.',
      },
      {
        label: 'From source',
        command: 'git clone https://github.com/fstubner/xtctx && cd xtctx && npm ci && npm run build',
        hint:
          'Useful for development. Then <code>node dist/src/cli/index.js serve</code>.',
      },
    ],
    tryCommands: [
      'xtctx init',
      'xtctx sync',
      'xtctx serve',
      'xtctx ingest --full',
      'xtctx --help',
    ],
    binariesNote:
      'Or read the <a href="https://github.com/fstubner/xtctx#readme" style="color:#ccc;text-decoration:underline;text-underline-offset:3px">full README</a> for hooks, policy merging, and MCP client config.',
  },

  faq: [
    {
      q: 'How is this different from a long context window?',
      a: 'A long context window is per-session and per-tool. xtctx is persistent and cross-tool. When you start a Cursor session tomorrow, the recall tools surface decisions you made in Claude Code last week, error solutions you saved from Codex two months ago, and the project conventions you wrote up once and never want to re-derive. The context window holds the current conversation; xtctx holds the project memory you carry between conversations.',
    },
    {
      q: 'Does it call out to any cloud service?',
      a: 'No. xtctx is local-first. Embeddings are computed in-process via @xenova/transformers, the search index is LanceDB on disk, and conversation history is read from the AI tools\' own local storage. There is no telemetry, no account, and no outbound network calls during normal operation. The only network access is the GitHub stars/downloads counter on this landing page itself.',
      aHtml:
        'No. xtctx is local-first. Embeddings are computed in-process via <code>@xenova/transformers</code>, the search index is <a href="https://lancedb.github.io/lancedb/">LanceDB</a> on disk, and conversation history is read from the AI tools\' own local storage. There is no telemetry, no account, and no outbound network calls during normal operation. The only network access is the GitHub stars/downloads counter on this landing page itself.',
    },
    {
      q: 'Which tools are supported?',
      a: 'Five: Claude Code, Cursor, GitHub Copilot, Codex, and Gemini CLI. Each has a scraper that reads the tool\'s native conversation storage, plus a sync target that renders the shared continuity policy into the tool\'s native config format (CLAUDE.md, .cursor/rules, MCP server config, etc.).',
      aHtml:
        'Five: <strong>Claude Code, Cursor, GitHub Copilot, Codex, and Gemini CLI</strong>. Each has a scraper that reads the tool\'s native conversation storage, plus a sync target that renders the shared continuity policy into the tool\'s native config format (<code>CLAUDE.md</code>, <code>.cursor/rules</code>, MCP server config, etc.).',
    },
    {
      q: 'How does it handle drift in tool storage formats?',
      a: 'Two layers. A mutation suite under tests/drift/ snapshots the parser output against fixtures from each tool, so a format change shows up as a failing test on the next CI run. A nightly canary workflow runs the live CLIs (Claude Code, Codex, Gemini) end-to-end against current versions to catch breakage that fixtures alone would miss. Cursor and Copilot are GUI tools so the canary covers three of five; the mutation suite covers all five.',
      aHtml:
        'Two layers. A <strong>mutation suite</strong> under <code>tests/drift/</code> snapshots the parser output against fixtures from each tool, so a format change shows up as a failing test on the next CI run. A <strong>nightly canary workflow</strong> runs the live CLIs (Claude Code, Codex, Gemini) end-to-end against current versions to catch breakage that fixtures alone would miss. Cursor and Copilot are GUI tools so the canary covers three of five; the mutation suite covers all five.',
    },
    {
      q: 'What about Cursor and Copilot — those are GUI tools, not CLIs?',
      a: 'Right, which is why the live CLI canary only covers three of the five tools. For the GUI tools we rely on the mutation suite — fixtures captured from real Cursor and Copilot installs, replayed against the parser on every CI run. If Cursor changes its conversation storage format, fixtures stop matching and the test fails before it ships.',
      aHtml:
        'Right, which is why the live CLI canary only covers three of the five tools. For the GUI tools we rely on the <strong>mutation suite</strong> — fixtures captured from real Cursor and Copilot installs, replayed against the parser on every CI run. If Cursor changes its conversation storage format, fixtures stop matching and the test fails before it ships.',
    },
    {
      q: 'What does the MCP integration look like in practice?',
      a: 'You add xtctx to your assistant\'s MCP server config (mcpServers.xtctx with command "xtctx" and args ["serve"]), and the assistant gets recall and writeback tools: xtctx_search, xtctx_project_knowledge, xtctx_recent_sessions for reading; xtctx_save_decision, xtctx_save_error_solution, xtctx_save_faq for writing. xtctx sync also generates SessionStart hooks for Claude Code so recall fires automatically at the top of every session.',
      aHtml:
        'You add xtctx to your assistant\'s MCP server config (<code>mcpServers.xtctx</code> with <code>command: "xtctx"</code> and <code>args: ["serve"]</code>), and the assistant gets recall and writeback tools: <code>xtctx_search</code>, <code>xtctx_project_knowledge</code>, <code>xtctx_recent_sessions</code> for reading; <code>xtctx_save_decision</code>, <code>xtctx_save_error_solution</code>, <code>xtctx_save_faq</code> for writing. <code>xtctx sync</code> also generates <code>SessionStart</code> hooks for Claude Code so recall fires automatically at the top of every session.',
    },
    {
      q: 'Is it open source?',
      a: 'Yes. xtctx is MIT-licensed. Source, issue tracker, and releases are at https://github.com/fstubner/xtctx. Releases are published to npm via OIDC trusted publishing on every GitHub Release.',
      aHtml:
        'Yes. xtctx is MIT-licensed. Source, issue tracker, and releases are at <a href="https://github.com/fstubner/xtctx">github.com/fstubner/xtctx</a>. Releases are published to <a href="https://www.npmjs.com/package/xtctx">npm</a> via OIDC trusted publishing on every GitHub Release.',
    },
  ],

  builtWith: [
    { name: 'LanceDB', url: 'https://lancedb.github.io/lancedb/' },
    { name: 'transformers.js', url: 'https://huggingface.co/docs/transformers.js' },
    { name: 'Model Context Protocol', url: 'https://modelcontextprotocol.io/' },
    { name: 'Astro', url: 'https://astro.build/' },
  ],

  social: { repo: REPO, showLiveStats: true },

  analytics: {},

  version: '0.6.0',
};
