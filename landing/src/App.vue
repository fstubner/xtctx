<script setup lang="ts">
import { ref } from "vue";
import runtimePreview from "./assets/runtime-screenshot.png";
import { useTheme } from "./composables/useTheme";

const { isDark, toggleTheme } = useTheme();
const copied = ref(false);

function copyInstall() {
  navigator.clipboard.writeText("npx xtctx init && npx xtctx sync && npx xtctx serve").then(() => {
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  });
}

const pillars = [
  {
    title: "Context continuity",
    detail:
      "Ingest local assistant histories and project writeback so another tool can resume with the same project state.",
  },
  {
    title: "Tool behavior sync",
    detail:
      "Generate and reconcile managed outputs for skills, commands, MCP config, slash commands, and assistant-specific instructions.",
  },
  {
    title: "Policy and scope control",
    detail:
      "Drive project, global, or hybrid behavior from one shared policy file instead of reconfiguring every assistant by hand.",
  },
];

const automation = [
  "Watch enabled local source paths and ingest new assistant sessions.",
  "Keep managed continuity blocks aligned with the effective tool policy.",
  "Expose searchable memory, source coverage, and sync status through the runtime UI, API, and MCP tools.",
];

const generatedOutputs = [
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  "copilot-instructions.md",
  "MCP + API",
];
</script>

<template>
  <div class="lp-shell">
    <header class="lp-nav">
      <a href="#top" class="lp-brand">
        <span class="lp-brand-mark">xt</span>
        <div>
          <span class="lp-brand-name">xtctx</span>
          <p class="lp-brand-subtitle">cross-tool context management</p>
        </div>
      </a>

      <nav class="lp-nav-links">
        <a href="#what-it-manages">What it manages</a>
        <a href="#automation">Automation</a>
        <a href="#quickstart">Quick start</a>
      </nav>

      <div class="lp-nav-actions">
        <button class="lp-btn-ghost" type="button" @click="toggleTheme">{{ isDark ? "Light" : "Dark" }}</button>
        <a class="lp-btn-ghost" href="https://github.com/fstubner/xtctx" target="_blank" rel="noreferrer">GitHub</a>
      </div>
    </header>

    <section id="top" class="lp-hero">
      <div class="lp-hero-copy">
        <p class="lp-eyebrow">Local-first continuity orchestration for AI coding tools</p>
        <h1 class="lp-hero-title">Keep context, tool behavior, and policy aligned across assistants.</h1>
        <p class="lp-hero-sub">
          xtctx ingests local conversation history, keeps project memory searchable per repository, and synchronizes
          assistant-specific config so switching tools does not reset the working state of the codebase.
        </p>

        <div class="lp-proof-row">
          <span>Local-first</span>
          <span>Per repository</span>
          <span>Config-first</span>
          <span>Assistant-agnostic</span>
        </div>

        <button class="lp-install" type="button" @click="copyInstall" :title="copied ? 'Copied' : 'Copy command'">
          <span class="lp-install-prompt">$</span>
          <code>npx xtctx init &amp;&amp; npx xtctx sync &amp;&amp; npx xtctx serve</code>
          <span class="lp-install-copy">{{ copied ? "Copied" : "Copy" }}</span>
        </button>

        <div class="lp-hero-actions">
          <a class="lp-btn" href="#quickstart">Get started</a>
          <a class="lp-btn-ghost" href="https://github.com/fstubner/xtctx" target="_blank" rel="noreferrer">Read the repo</a>
        </div>

        <p class="lp-works-with">
          Works with Claude Code, Cursor, Codex CLI, GitHub Copilot, Gemini CLI, and any workflow that can consume the
          generated continuity outputs.
        </p>
      </div>

      <div class="lp-hero-visual">
        <article class="lp-visual-card">
          <div class="lp-visual-header">
            <div>
              <p class="lp-eyebrow">Runtime control plane</p>
              <h2 class="lp-visual-title">Visibility into the automation, not another assistant UI</h2>
            </div>
          </div>
          <img :src="runtimePreview" alt="xtctx runtime control plane screenshot" class="lp-runtime-preview" />
        </article>

        <article class="lp-visual-card">
          <div class="lp-generated-grid">
            <div>
              <p class="lp-eyebrow">Managed outputs</p>
              <h2 class="lp-visual-title">One repo policy, rendered into tool-native surfaces</h2>
            </div>
            <ul class="lp-generated-list">
              <li v-for="item in generatedOutputs" :key="item">{{ item }}</li>
            </ul>
          </div>
        </article>
      </div>
    </section>

    <section id="what-it-manages" class="lp-section">
      <div class="lp-section-header">
        <p class="lp-eyebrow">What xtctx manages</p>
        <h2 class="lp-h2">The product is not just memory. It orchestrates continuity across the full tool surface.</h2>
      </div>

      <div class="lp-pillar-grid">
        <article v-for="pillar in pillars" :key="pillar.title" class="lp-pillar-card">
          <h3>{{ pillar.title }}</h3>
          <p>{{ pillar.detail }}</p>
        </article>
      </div>
    </section>

    <section id="automation" class="lp-section">
      <div class="lp-section-header">
        <p class="lp-eyebrow">What runs automatically</p>
        <h2 class="lp-h2">Once the runtime is up, xtctx handles the background continuity work.</h2>
      </div>

      <div class="lp-automation-layout">
        <div class="lp-automation-list">
          <article v-for="(item, index) in automation" :key="item" class="lp-automation-item">
            <span class="lp-automation-num">{{ String(index + 1).padStart(2, '0') }}</span>
            <p>{{ item }}</p>
          </article>
        </div>

        <aside class="lp-callout">
          <p class="lp-eyebrow">Runtime UI role</p>
          <h3>Use the web UI as the control plane.</h3>
          <p>
            The dashboard exists to inspect source coverage, tool sync drift, indexing state, and runtime activity.
            Recall and writeback happen through your assistants and MCP tools, not by manually driving the web app.
          </p>
        </aside>
      </div>
    </section>

    <section id="quickstart" class="lp-section">
      <div class="lp-section-header">
        <p class="lp-eyebrow">Quick start</p>
        <h2 class="lp-h2">Bootstrap a repository, then let continuity run in the background.</h2>
      </div>

      <div class="lp-quickstart-grid">
        <article class="lp-panel">
          <h3>Bootstrap the repo</h3>
          <ol>
            <li>Initialize `.xtctx` memory and policy files.</li>
            <li>Render assistant-specific continuity outputs.</li>
            <li>Start the local API, MCP server, and runtime UI.</li>
          </ol>

          <div class="lp-terminal">
            <div class="lp-terminal-bar">
              <span class="lp-terminal-dot" style="--c:#ff5f57"></span>
              <span class="lp-terminal-dot" style="--c:#ffbd2e"></span>
              <span class="lp-terminal-dot" style="--c:#28c840"></span>
              <span class="lp-terminal-label">bootstrap</span>
            </div>
            <pre>npx xtctx init
npx xtctx sync
npx xtctx serve</pre>
          </div>
        </article>

        <article class="lp-panel">
          <h3>What happens next</h3>
          <ul>
            <li>Assistant histories continue to ingest from configured local sources.</li>
            <li>Managed continuity targets can be inspected and reconciled from the runtime UI.</li>
            <li>Project decisions, fixes, and FAQs remain queryable through MCP and the memory surface.</li>
          </ul>

          <div class="lp-note">
            <p class="lp-eyebrow">Operator model</p>
            <p>Configure and observe in the web UI. Recall and writeback through your assistant.</p>
          </div>
        </article>
      </div>
    </section>

    <footer class="lp-footer">
      <p>xtctx is open source under MIT.</p>
      <a href="https://github.com/fstubner/xtctx" target="_blank" rel="noreferrer">GitHub</a>
    </footer>
  </div>
</template>
