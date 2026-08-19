# xtctx — Design Direction

The product's user-facing surfaces are (1) CLI output, (2) markdown returned
to agents over MCP, and (3) the static landing site at xtctx.com. There is no
app UI, and none is planned (see PRODUCT.md non-goals).

## Interview

Direction was set by the maintainer (solo project) rather than an external
interview; recorded here so it can be argued with later:

- **Who is looking at this?** Developers in a terminal, and LLMs parsing
  tool output. Both reward the same thing: terse, stable, unambiguous text.
- **What should it feel like?** Plumbing. xtctx succeeds when it is
  invisible — no banners, no color dependence, no spinner theater. Status
  output is aligned plain text with `+`/`-`/`ok`/`updated` markers that
  survive being piped or pasted.
- **What must it never do?** Overclaim. The landing site and CLI copy state
  what exists (five read-only tools, local index) and explicitly what does
  not (no daemon, no memory, no summaries). The landing test suite asserts
  the *absence* of overclaiming phrases.
- **Visual identity (landing only):** dark, monospace-leaning, terminal
  aesthetic; tokens live in `styles/xtctx-tokens.css` and
  `landing/src/styles/global.css`. Content is data-driven from
  `landing/src/data/site.ts` so copy stays testable.
- **Accessibility bar:** landing pages must remain readable with CSS off
  (semantic HTML first), and CLI output must not encode meaning in color
  alone. Text/surface contrast is checked mechanically: `design-tokens.json`
  mirrors the `--xt-text`/`--xt-text-muted`/`--xt-bg` values from
  `styles/xtctx-tokens.css` per theme (keep them in sync when the palette
  changes), and the frontend checker holds every pair to WCAG 4.5:1.

Machine-facing formats are part of the design surface: markdown responses
fence transcript bodies and label them untrusted; JSON responses mirror the
markdown data 1:1 so orchestrators never parse prose.
