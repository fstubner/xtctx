import type { Hero, HeroCommands, HeroDownload } from './types';

export const hero: Hero = {
  // Platforms, licence, language — whatever a visitor cannot get from the
  // headline. Keep it to three or four items.
  badge: 'Local transcript retrieval for AI coding tools',
  // The strongest on-page signal after the title. Say what the thing is and
  // who it is for; "modern" and "powerful" are not what anyone searches for.
  heading: 'Keep project context portable across coding tools.',
  subhead:
    'Move between supported coding agents without starting over. xtctx indexes the transcript files your tools already write and serves them over MCP, so the next agent can pick up recent context. Install the plugin once to reach the tools everywhere, then opt each project in with a single setup command.',
  // The two commands the hero shows before any script runs. os-tabs.ts
  // replaces both once the visitor's platform is known — see heroCommands
  // below — so these are the defaults a crawler and a no-JavaScript visitor
  // get. Make them the ones that work for the widest audience.
  quickInstall: 'claude plugin marketplace add fstubner/xtctx && claude plugin install xtctx@xtctx',
  // Source has no quickInstallAlt; second install route used (setup command).
  quickInstallAlt: 'npx -y xtctx setup',
  installLinkLabel: 'Get started',
  // Source has no hero image.
  heroImage: '',
  heroImageAlt: '',
  heroImageWidth: 0,
  heroImageHeight: 0,
  sourceUrl: 'https://github.com/fstubner/xtctx',
  // No desktop build in source.
  downloadLabel: '',
  downloadMenuLabel: '',
};

// The hero's two command rows, per platform. `packageManager` goes in the
// narrower row, `script` in the wide row beside the download button — keyed
// by which row they suit, not by which is "recommended".
// Source install is not OS-specific; same commands on every platform.
export const heroCommands: HeroCommands = {
  windows: {
    packageManager: 'claude plugin marketplace add fstubner/xtctx && claude plugin install xtctx@xtctx',
    script: 'npx -y xtctx setup',
  },
  macos: {
    packageManager: 'claude plugin marketplace add fstubner/xtctx && claude plugin install xtctx@xtctx',
    script: 'npx -y xtctx setup',
  },
  linux: {
    packageManager: 'claude plugin marketplace add fstubner/xtctx && claude plugin install xtctx@xtctx',
    script: 'npx -y xtctx setup',
  },
};

// The installers behind the hero's "Desktop app" button, in menu order. The
// first is what the button points at before any script runs.
//
// A product with no desktop build leaves this empty: the button, its caption
// and the menu are then not rendered at all, and the install command takes
// the whole row.
export const heroDownloads: HeroDownload[] = [];
