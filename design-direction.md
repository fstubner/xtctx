# xtctx — Design Direction

The product's user-facing surfaces are (1) CLI output, (2) markdown returned
to agents over MCP, and (3) the static site at xtctx.com. There is no
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
- **What must it never do?** Overclaim. The site and CLI copy state
  what exists (five read-only tools, local index) and explicitly what does
  not (no daemon, no memory, no summaries). `tests/site/` asserts the
  *absence* of overclaiming phrases.
- **Visual identity (site only):** dark navy, cream text, amber accent. The
  site in `site/` is built on product-site-template, so the palette lives in
  `site/src/styles/tokens.css` and is changed with `npm --prefix site run
  theme -- --accent "#e8b878" --verify`. All copy is in
  `site/src/data/site-content/` so it stays testable. `docs/design/xtctx-tokens.css`
  and `design-tokens.json` are the palette the site's tokens were taken from;
  nothing builds from them any more.
- **Accessibility bar:** site pages must remain readable with CSS off
  (semantic HTML first), and CLI output must not encode meaning in color
  alone. Contrast is checked on the rendered pages: the site's
  `check:contrast` sweep and `test:a11y` measure every text node in both
  themes against WCAG 4.5:1.

Machine-facing formats are part of the design surface: markdown responses
fence transcript bodies and label them untrusted; JSON responses mirror the
markdown data 1:1 so orchestrators never parse prose.
