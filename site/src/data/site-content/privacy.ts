import type { PrivacyCopy } from './privacy-types';

// The privacy page (/privacy/). Every claim here was checked against the code
// on 2026-10-05: the CLI's only outbound requests are the four opt-in paths
// listed (login and sync to the user's own server, a configured remote
// embedding endpoint, and the one-time `embeddings enable` download); the
// Antigravity scraper talks to 127.0.0.1 only; the site sets no analytics
// token (footer.ts) and stores only the two localStorage keys named below.
// Re-check before adding a feature that connects anywhere.
export const privacyCopy: PrivacyCopy = {
  heading: 'Privacy',
  leadHtml:
    'xtctx runs on your computer and collects nothing. It has no telemetry, no analytics, no crash reports and no update checks. Transcript text leaves your machine only through the two opt-in features listed below.',
  bodyHtml: `
<h2>What stays on your computer</h2>
<p>xtctx reads the transcripts your coding agents already write on this machine. For Google Antigravity it asks the Antigravity app running on this computer, over 127.0.0.1.</p>
<p>It keeps a search index of those transcripts in <code>.xtctx/state/</code> inside each project. Machine-wide settings live in <code>~/.xtctx/</code>. Nothing in either is sent anywhere unless you turn on one of the features below.</p>

<h2>What reaches the internet</h2>
<p>Each of these is off until you turn it on:</p>
<ul>
  <li><strong>Local semantic search.</strong> <code>xtctx embeddings enable</code> downloads the model and its runtime once, from the npm registry and huggingface.co. Search then runs on your machine. <code>xtctx embeddings disable</code> removes them.</li>
  <li><strong>A remote embedding endpoint.</strong> If a project's config names one, transcript text from that project is sent to it to be embedded. Remove it from the config to stop.</li>
  <li><strong>Cloud sync.</strong> <code>xtctx login</code> and sync send transcripts to a server you deploy yourself, at the address you give. There is no hosted xtctx service.</li>
</ul>
<p>Installing or updating xtctx downloads it from npm, like any npm package.</p>

<h2>This website</h2>
<p>xtctx.com is static pages on GitHub Pages, served through Cloudflare. Both see the requests your browser makes, as any host does. The pages run no analytics and set no cookies.</p>
<p>Your browser asks api.github.com for the repository's star count, download count and release notes. Your theme choice and the operating-system tab you pick in the install section are kept in your browser's local storage, and never leave it.</p>

<h2>Contact</h2>
<p>Questions go to the <a href="https://github.com/fstubner/xtctx/issues">issue tracker on GitHub</a>.</p>
`,
};
