import type { AppSchema, Branding, Meta } from './types';

// Sample content. Everything in this directory describes one fictional
// product -- "Example", a command-line tool -- so the site builds, renders
// and passes its own checks out of the box. Replace it; the shell reads
// these files and nothing else.

export const meta: Meta = {
  domain: 'https://xtctx.com',
  // Aim for a title under about 60 characters: that is what a search result
  // shows. Lead with the product name, then what it is, in the words someone
  // would actually search for.
  title: 'xtctx - Move between coding agents without starting over',
  // 150-160 characters. Longer gets truncated mid-sentence, and the end of
  // the sentence is usually the part worth reading.
  description:
    'xtctx writes local MCP config and managed instructions so AI coding tools can read recent transcript sessions from the current repo.',
  // Shown when the page is shared, where there is a little more room.
  ogDescription:
    'Local setup, status, skill sync, and MCP transcript retrieval for AI coding tools.',
  siteName: 'xtctx',
  author: { name: 'Felix Stubner', url: 'https://github.com/fstubner' },
  ogImage: 'https://xtctx.com/favicon.svg',
  // No source ogImageAlt in landing/src/data/site.ts.
  ogImageAlt: '',
  faviconPath: '/favicon.svg',
  themeColor: '#0a1424',
};

// Facts about the PRODUCT for the JSON-LD, not about this site. These were
// literals in src/layouts/Page.astro until a site shipped the wrong language
// for its own program, because no gate read a value nothing listed.
// Source landing/src/data/site.ts has no appSchema; empty rather than invent.
export const appSchema: AppSchema = {
  applicationCategory: '',
  applicationSubCategory: '',
  operatingSystem: '',
  license: 'https://opensource.org/licenses/MIT',
  programmingLanguage: '',
  price: '0',
  priceCurrency: 'USD',
};

export const branding: Branding = {
  wordmark: '/assets/wordmark.png',
  wordmarkAlt: 'xtctx',
  accentGradient: 'linear-gradient(90deg,#e8dfc8,#e8b878)',
  bg: '#0a1424',
  fg: '#e8dfc8',
};
