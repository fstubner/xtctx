import { defineConfig } from 'astro/config';

// Canonical site URL. Used by Astro for absolute URL generation in
// sitemap/RSS integrations if we add them later, and surfaces in the
// generated HTML via the built-in `Astro.site` global.
export default defineConfig({
  site: 'https://xtctx.com',
  build: {
    // Force-inline the Astro-generated CSS. Our full stylesheet is small
    // enough that the round-trip cost of a render-blocking <link> is more
    // expensive than inlining. 'always' replaces the <link> with a <style>.
    inlineStylesheets: 'always',
  },
});
