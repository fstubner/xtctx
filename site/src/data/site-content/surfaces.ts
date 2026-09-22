import type { SectionCopy, SurfaceCard } from './types';

export const surfacesCopy: SectionCopy = {
  heading: 'What setup writes',
  leadHtml:
    'The plugin writes nothing into your project. Running setup adds config, managed instructions, selected skill targets, and a rebuildable SQLite cache. Raw transcript files remain the source of truth.',
};

export const surfaces: SurfaceCard[] = [
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
├── <span class="var-text">retrieval_units</span>
├── <span class="var-text">retrieval_units_fts</span>
└── <span class="var-text">retrieval_unit_vectors</span>`,
  },
];
