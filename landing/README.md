# xtctx landing

Static Astro 5 site published to https://xtctx.com via the
`deploy-landing.yml` GitHub Actions workflow. Zero JS by default; only
the copy-button handler in `src/pages/index.astro` ships to the browser.
Primary landing-page copy, including hero,
surface cards, install matrix, FAQ, and footer, is config-driven from
`src/data/site.ts`. To retarget the site, edit that one file; to change
layout or chrome, edit the matching component in `src/components/`.
Run from the repo root with `npm run landing:dev`,
`npm run landing:build`, or `npm run landing:preview`.
