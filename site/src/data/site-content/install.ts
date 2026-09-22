import type { Platform, PlatformInstall, SectionCopy, TryCommand } from './types';

export const installCopy: SectionCopy = {
  heading: 'Install, then check',
  leadHtml:
    'The plugin gets you the MCP tools in every project. Add setup where you want the handoff delivered automatically, and use status to check what is wired.',
};

// Source install is a flat list, not per-OS. Same CLI entries on every
// platform; no desktop build.
const cliEntries = [
  {
    label: 'Install the plugin',
    command: 'claude plugin marketplace add fstubner/xtctx && claude plugin install xtctx@xtctx',
    hint:
      'Registers the MCP server and the handoff skill machine-wide, and writes nothing into your project. The tools then reach every project; each one answers once it has been set up, and names the command until then. Codex, Copilot, Cursor and Antigravity install from the same marketplace; see the README for their commands.',
  },
  {
    label: 'Add project wiring',
    command: 'npx -y xtctx setup',
    hint:
      'Optional upgrade. Writes managed instruction blocks so the next agent receives the handoff without calling a tool, plus the SessionStart hook, per-tool MCP config, and skill sync. The only route for opencode.',
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
];

export const installByPlatform: Record<Platform, PlatformInstall> = {
  windows: { cli: cliEntries, desktop: [] },
  macos: { cli: cliEntries, desktop: [] },
  linux: { cli: cliEntries, desktop: [] },
};

// The "try it" block: the first few commands someone runs after installing.
// Source tryCommands are bare strings; no comments in source.
export const tryCommands: TryCommand[] = [
  { comment: '', command: 'npx -y xtctx setup' },
  { comment: '', command: 'npx -y xtctx status' },
  { comment: '', command: 'npx -y xtctx --help' },
];

export const installBinariesNote =
  'Read the <a href="https://github.com/fstubner/xtctx#readme">README</a> for supported tools and local transcript notes.';

// Two things /llms.txt says that no page does: a build-from-source route and
// any caveat a reader acting on the install list needs. One line each.
// No source fromSource / installNotes.
export const installFromSource = '';

export const installNotes: string[] = [];
