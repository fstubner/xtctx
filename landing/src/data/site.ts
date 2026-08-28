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
  proof: string[];
  quickInstall: string;
  installLinkLabel: string;
  heroImage?: string;
  heroImageAlt?: string;
  heroImageWidth?: number;
  heroImageHeight?: number;
  heroImageWebp?: string;
  sourceUrl: string;
}

export interface SectionCopy {
  heading: string;
  leadHtml: string;
}

export interface WorkflowStep {
  label: string;
  title: string;
  body: string;
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

export interface Analytics {
  cloudflareToken?: string;
}

export interface SiteData {
  meta: Meta;
  branding: Branding;
  hero: Hero;
  copy: {
    workflow: SectionCopy;
    surfaces: SectionCopy;
    install: SectionCopy;
    faq: SectionCopy;
  };
  workflow: WorkflowStep[];
  surfaces: SurfaceCard[];
  install: {
    entries: InstallEntry[];
    tryCommands: string[];
    binariesNote: string;
  };
  faq: FaqItem[];
  builtWith: BuiltWithEntry[];
  analytics: Analytics;
  version: string;
}

const REPO = 'fstubner/xtctx';
const REPO_URL = `https://github.com/${REPO}`;

export const site: SiteData = {
  meta: {
    domain: 'https://xtctx.com',
    title: 'xtctx - Move between coding agents without starting over',
    description:
      'xtctx writes local MCP config and managed instructions so AI coding tools can read recent transcript sessions from the current repo.',
    ogDescription:
      'Local setup, status, skill sync, and MCP transcript retrieval for AI coding tools.',
    keywords:
      'mcp server, model context protocol, ai coding agents, synced skills, claude code, cursor, codex, google antigravity, opencode, local transcripts, cross tool handoff, semantic transcript search',
    siteName: 'xtctx',
    author: { name: 'Felix Stubner', url: 'https://github.com/fstubner' },
    ogImage: 'https://xtctx.com/favicon.svg',
    faviconPath: '/favicon.svg',
    themeColor: '#0a1424',
  },

  branding: {
    wordmarkAlt: 'xtctx',
    accentGradient: 'linear-gradient(90deg,#e8dfc8,#e8b878)',
    bg: '#0a1424',
    fg: '#e8dfc8',
  },

  hero: {
    badge: 'Local transcript retrieval for AI coding tools',
    heading: 'Keep project context portable across coding tools.',
    subhead:
      'Move between supported coding agents without starting over. xtctx writes local MCP configs and managed instructions so the next agent can retrieve recent context through MCP.',
    proof: ['Setup writes local config', 'Raw transcripts stay local', 'Five MCP tools'],
    quickInstall: 'npx -y xtctx setup',
    installLinkLabel: 'Get started',
    sourceUrl: REPO_URL,
  },

  copy: {
    workflow: {
      heading: 'What happens after setup',
      leadHtml:
        'xtctx is not a dashboard or memory layer. It is project-local wiring plus MCP retrieval against transcript files your tools already write.',
    },
    surfaces: {
      heading: 'What xtctx writes',
      leadHtml:
        'Setup writes config, managed instructions, selected skill targets, and a rebuildable SQLite cache. Raw transcript files remain the source of truth.',
    },
    install: {
      heading: 'Run setup, then status',
      leadHtml:
        'Start with setup in the repo. Use status to check configured tools, transcript freshness, selected skills, and drift.',
    },
    faq: {
      heading: 'Questions before using it in a repo',
      leadHtml: 'Short answers about setup, local storage, transcript limits, and what xtctx does not do.',
    },
  },

  workflow: [
    {
      label: '01',
      title: 'Run setup',
      body:
        'xtctx writes project-level MCP config and managed instruction blocks. Antigravity MCP is always configured. Copilot CLI still requires --global-mcp.',
    },
    {
      label: '02',
      title: 'Open another tool',
      body:
        'The tool reads the managed instructions and can start xtctx over stdio as an MCP server.',
    },
    {
      label: '03',
      title: 'Read recent sessions',
      body:
        'MCP calls list sessions, open raw transcript messages, and search chronological transcript windows.',
    },
    {
      label: '04',
      title: 'Check status',
      body:
        'Status reports configured tools, selected skills, transcript freshness, and unsupported targets.',
    },
  ],

  surfaces: [
    {
      title: 'Five MCP tools',
      body:
        'Agents can list recent sessions, open session detail, search transcript windows, check continuity status, and fetch a handoff manifest.',
      codeHtml: `<span class="dim">agent calls</span> xtctx_recent_sessions
<span class="dim">agent opens</span> xtctx_session_detail
<span class="dim">agent searches</span> xtctx_search_sessions
<span class="dim">agent checks</span> xtctx_continuity_status
<span class="dim">orchestrator reads</span> xtctx_handoff_manifest`,
    },
    {
      title: 'Managed setup files',
      body:
        'Setup owns generated instruction blocks, MCP config, and selected skill targets so the repo wiring is repeatable.',
      flip: true,
      codeHtml: `<span class="dim">$</span> <span class="cmd-text">npx -y xtctx setup</span>
<span class="success-text">updated</span> .xtctx/config.yaml
<span class="success-text">updated</span> .xtctx/skills/xtctx-handoff/SKILL.md
<span class="success-text">updated</span> AGENTS.md
<span class="success-text">updated</span> .codex/config.toml
<span class="success-text">verified</span> MCP config`,
    },
    {
      title: 'Status output',
      body:
        'Status reports configured tools, transcript freshness, selected skills, managed blocks, and unsupported targets.',
      codeHtml: `<span class="dim">$</span> <span class="cmd-text">npx -y xtctx status</span>
<span class="success-text">configured</span>
<span class="info-text">mcp command</span> npx -y xtctx
<span class="info-text">cache</span> 12 sessions
<span class="info-text">codex</span> instruction only
<span class="info-text">claude-code</span> executable hook`,
    },
    {
      title: 'Search stays local',
      body:
        'Raw transcript files remain the source of truth. SQLite is a rebuildable local index for ordered lookup and fallback keyword search.',
      flip: true,
      codeHtml: `<span class="info-text">cache</span> <span class="var-text">.xtctx/state/xtctx.db</span>
├── <span class="var-text">sessions</span>
├── <span class="var-text">messages</span>
├── <span class="var-text">retrieval_windows</span>
├── <span class="var-text">vectors</span>
└── <span class="var-text">fts_index</span>`,
    },
  ],

  install: {
    entries: [
      {
        label: 'Set up this repo',
        command: 'npx -y xtctx setup',
        hint:
        'Writes project-level MCP config, syncs selected skills, always configures Antigravity MCP, and repairs managed instruction blocks. Use --global-mcp only for Copilot CLI.',
      },
      {
        label: 'Check what is wired',
        command: 'npx -y xtctx status',
        hint:
          'Reports configured tools, cached transcript freshness, skill drift, managed blocks, and repair hints.',
      },
      {
        label: 'Start MCP over stdio',
        command: 'npx -y xtctx',
        hint:
          'Starts the MCP server for clients. In a normal terminal it prints setup and status help.',
      },
    ],
    tryCommands: [
      'npx -y xtctx setup',
      'npx -y xtctx status',
      'npx -y xtctx --help',
    ],
    binariesNote:
      'Read the <a href="https://github.com/fstubner/xtctx#readme">README</a> for supported tools and local transcript notes.',
  },

  faq: [
    {
      q: 'What problem does xtctx solve?',
      a: 'It lets a configured AI coding tool read recent local transcript sessions from the current repo through MCP.',
    },
    {
      q: 'Does xtctx run a background service?',
      a: 'No. xtctx has no daemon, API server, dashboard, watcher, or web service. MCP retrieval calls update the local cache on demand.',
    },
    {
      q: 'Does xtctx sync skills?',
      a: 'Yes. Setup writes the built-in xtctx-handoff skill, inventories compatible skills from connected tools, and syncs selected project skills to supported targets.',
    },
    {
      q: 'Does it summarize sessions?',
      a: 'No. xtctx points agents to recent raw transcript messages. Those messages stay the source of truth.',
    },
    {
      q: 'What are the limits?',
      a: 'xtctx is local-only. Transcript formats can change upstream, semantic vectors are created lazily, and keyword fallback is expected when local vector generation is unavailable.',
    },
    {
      q: 'Can I test it without private transcripts?',
      a: 'Yes. The public demo smoke creates synthetic Claude Code and Codex transcript stores in a temporary project, then calls the built MCP server over stdio.',
      aHtml:
        'Yes. The <a href="https://github.com/fstubner/xtctx/blob/main/docs/demo.md">public demo smoke</a> creates synthetic Claude Code and Codex transcript stores in a temporary project, then calls the built MCP server over stdio.',
    },
    {
      q: 'Which tools are supported?',
      a: 'Claude Code, Cursor, Codex, GitHub Copilot, Google Antigravity, opencode, and GitHub Copilot CLI.',
    },
    {
      q: 'Where does data live?',
      a: 'Project config lives in .xtctx/config.yaml. The rebuildable SQLite cache lives in .xtctx/state/xtctx.db. Source transcripts stay in each tool storage location.',
    },
    {
      q: 'Is it open source?',
      a: 'Yes. xtctx is MIT licensed and published at github.com/fstubner/xtctx.',
      aHtml:
        'Yes. xtctx is MIT licensed and published at <a href="https://github.com/fstubner/xtctx">github.com/fstubner/xtctx</a>.',
    },
  ],

  builtWith: [
    { name: 'Model Context Protocol', url: 'https://modelcontextprotocol.io/' },
    { name: 'SQLite', url: 'https://www.sqlite.org/' },
    { name: 'Astro', url: 'https://astro.build/' },
  ],

  analytics: {},

  version: '0.31.0', // x-release-please-version
};
