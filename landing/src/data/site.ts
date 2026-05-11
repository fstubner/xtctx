export interface Meta {
  domain: string;
  title: string;
  description: string;
  ogDescription?: string;
  keywords: string;
  siteName: string;
  author: { name: string; url: string };
  ogImage: string;
  faviconPath: string;
  themeColor: string;
}

export interface Branding {
  wordmark?: string;
  wordmarkAlt: string;
  accentGradient: string;
  bg: string;
  fg: string;
}

export interface Hero {
  badge: string;
  heading: string;
  subhead: string;
  quickInstall: string;
  installLinkLabel: string;
  heroImage?: string;
  heroImageAlt?: string;
  heroImageWidth?: number;
  heroImageHeight?: number;
  heroImageWebp?: string;
  sourceUrl: string;
}

export interface SurfaceCard {
  title: string;
  body: string;
  image?: {
    src: string;
    webp?: string;
    alt: string;
    width: number;
    height: number;
  };
  codeHtml?: string;
  flip?: boolean;
}

export interface InstallEntry {
  label: string;
  command: string;
  hint?: string;
}

export interface FaqItem {
  q: string;
  a: string;
  aHtml?: string;
}

export interface BuiltWithEntry {
  name: string;
  url: string;
}

export interface SocialProof {
  repo: string;
  showLiveStats?: boolean;
}

export interface Analytics {
  cloudflareToken?: string;
}

export interface SectionCopy {
  heading: string;
  leadHtml: string;
}

export interface SiteData {
  meta: Meta;
  branding: Branding;
  hero: Hero;
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
  version: string;
}

const REPO = 'fstubner/xtctx';
const REPO_URL = `https://github.com/${REPO}`;

export const site: SiteData = {
  meta: {
    domain: 'https://xtctx.com',
    title: 'xtctx - Local handoff for AI coding agents',
    description:
      'xtctx configures MCP and tool instruction files so AI coding agents can retrieve recent local transcript sessions when you switch tools.',
    ogDescription:
      'Local cross-tool handoff for AI coding agents. Setup, status, MCP transcript retrieval.',
    keywords:
      'mcp server, model context protocol, ai coding, claude code, cursor, github copilot, codex, gemini cli, google antigravity, opencode, local transcripts, cross-tool handoff',
    siteName: 'xtctx',
    author: { name: 'Felix Stubner', url: 'https://github.com/fstubner' },
    ogImage: 'https://xtctx.com/favicon.svg',
    faviconPath: '/favicon.svg',
    themeColor: '#111',
  },

  branding: {
    wordmarkAlt: 'xtctx',
    accentGradient: 'linear-gradient(90deg,#7c5cff,#22b8cf 50%,#0aae7a)',
    bg: '#111',
    fg: '#d4d4d4',
  },

  hero: {
    badge: 'Open source · MIT · Node ≥20 · Local-first',
    heading: 'Switch AI coding tools without losing the thread',
    subhead:
      'xtctx wires MCP, hooks, and managed instructions so the next agent can list recent local sessions and open the raw transcript detail it needs.',
    quickInstall: 'npx -y xtctx setup',
    installLinkLabel: 'Setup options ↓',
    sourceUrl: REPO_URL,
  },

  copy: {
    surfaces: {
      heading: 'What it does',
      leadHtml:
        'Small surface, direct mechanics: setup wiring, status diagnostics, and MCP transcript retrieval. <a href="https://github.com/fstubner/xtctx#readme">Full README →</a>',
    },
    install: {
      heading: 'Get started',
      leadHtml:
        'Run setup once per project, then let MCP retrieve sessions on demand.',
    },
    faq: {
      heading: 'FAQ',
      leadHtml: 'The questions people ask before trusting local handoff.',
    },
  },

  surfaces: [
    {
      title: 'MCP retrieves raw transcript context',
      body:
        'Agents call <code>xtctx_recent_sessions</code> to find recent work, <code>xtctx_search_sessions</code> to search chronological transcript windows, then <code>xtctx_session_detail</code> to read the relevant raw messages. No generated narrative summary is treated as truth.',
      codeHtml: `<span style="color:#888">// handoff flow</span>
<span style="color:#7c9fc7">xtctx_recent_sessions</span>({ <span style="color:#7c9fc7">limit</span>: <span style="color:#b48ead">5</span> })
<span style="color:#7c9fc7">xtctx_session_detail</span>({ <span style="color:#7c9fc7">session_ref</span>, <span style="color:#7c9fc7">limit</span>: <span style="color:#b48ead">50</span> })
<span style="color:#7c9fc7">xtctx_search_sessions</span>({ <span style="color:#7c9fc7">query</span>: <span style="color:#8fbc7f">"auth callback"</span> })`,
    },
    {
      title: 'Setup owns the wiring',
      body:
        '<code>xtctx setup</code> writes MCP config as <code>npx -y xtctx</code>, installs executable hooks only where they exist, and repairs stale generated blocks without touching user notes outside the fences.',
      flip: true,
      codeHtml: `<span style="color:#888">$</span> npx -y xtctx setup
<span style="color:#888">updated</span> config .xtctx/config.yaml
<span style="color:#888">updated</span> mcp:codex .codex/config.toml
<span style="color:#888">updated</span> instructions:codex AGENTS.md
<span style="color:#888">updated</span> hook:claude-code .claude/hooks.json`,
    },
    {
      title: 'Status reports actual state',
      body:
        '<code>xtctx status</code> shows detected transcript stores, indexed sessions, hook mode, MCP command, managed-block drift, and stale references. It does not pretend a background service is running.',
      codeHtml: `<span style="color:#888">$</span> xtctx status
xtctx 0.10.0 - handoff status
MCP      npx -y xtctx
Data     12 sessions, 164 messages, 42 retrieval windows

Tools:
  + codex         detected; 4 sessions; hook: instruction-only
  + claude-code   detected; 8 sessions; hook: executable`,
    },
    {
      title: 'Local cache, authoritative sources',
      body:
        'xtctx stores a rebuildable SQLite handoff index under <code>.xtctx/state/</code>, including local semantic vectors for chronological transcript windows. The source transcripts in each tool remain authoritative, and MCP calls update the cache lazily.',
      flip: true,
      codeHtml: `<span style="color:#888">$</span> ls .xtctx/
config.yaml      state/

<span style="color:#888">$</span> sqlite3 .xtctx/state/xtctx.db '.tables'
messages      retrieval_units  retrieval_unit_vectors
messages_fts  sessions         settings`,
    },
  ],

  install: {
    entries: [
      {
        label: 'Project setup',
        command: 'npx -y xtctx setup',
        hint:
          'Detects tools, writes MCP config, installs supported hooks, and repairs managed instruction blocks.',
      },
      {
        label: 'Check wiring',
        command: 'npx -y xtctx status',
        hint:
          'Shows real handoff state and repair hints for stale generated files.',
      },
      {
        label: 'From source',
        command: 'git clone https://github.com/fstubner/xtctx && cd xtctx && npm ci && npm run build',
        hint:
          'Useful for development. Then run <code>node dist/src/cli/index.js --help</code>.',
      },
    ],
    tryCommands: [
      'xtctx setup',
      'xtctx status',
      'xtctx --help',
    ],
    binariesNote:
      'Read the <a href="https://github.com/fstubner/xtctx#readme" style="color:#ccc;text-decoration:underline;text-underline-offset:3px">README</a> for supported tools and MCP configuration details.',
  },

  faq: [
    {
      q: 'Does xtctx run a background service?',
      a: 'No. xtctx has no daemon or web service in the handoff design. MCP calls and real startup hooks update the local cache on demand.',
    },
    {
      q: 'Does it summarize my sessions?',
      a: 'No. Managed blocks point the agent to transcript retrieval tools. Raw local transcript messages are the source of truth.',
    },
    {
      q: 'Which tools are supported?',
      a: 'Claude Code, Cursor, Codex, GitHub Copilot, Gemini CLI, Google Antigravity, opencode, and GitHub Copilot CLI.',
    },
    {
      q: 'Where does the data live?',
      a: 'Project configuration lives in .xtctx/config.yaml. The rebuildable local cache lives in .xtctx/state/xtctx.db. Source transcripts stay in each tool\'s own local storage; Antigravity transcript steps are read from its local language server when the app is running.',
    },
    {
      q: 'What does the MCP integration look like?',
      a: 'Generated MCP config uses command "npx" with args ["-y", "xtctx"]. The exposed tools are xtctx_recent_sessions, xtctx_session_detail, xtctx_search_sessions, and xtctx_continuity_status.',
    },
    {
      q: 'Is it open source?',
      a: 'Yes. xtctx is MIT-licensed. Source, issue tracker, and releases are at https://github.com/fstubner/xtctx.',
      aHtml:
        'Yes. xtctx is MIT-licensed. Source, issue tracker, and releases are at <a href="https://github.com/fstubner/xtctx">github.com/fstubner/xtctx</a>.',
    },
  ],

  builtWith: [
    { name: 'Model Context Protocol', url: 'https://modelcontextprotocol.io/' },
    { name: 'SQLite', url: 'https://www.sqlite.org/' },
    { name: 'Astro', url: 'https://astro.build/' },
  ],

  social: { repo: REPO, showLiveStats: true },

  analytics: {},

  version: '0.10.0',
};
