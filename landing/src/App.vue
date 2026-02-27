<script setup lang="ts">
import Button from "primevue/button";
import Card from "primevue/card";
import Tag from "primevue/tag";
import { useTheme } from "./composables/useTheme";
import runtimePreview from "./assets/runtime-screenshot.png";

const { isDark, toggleTheme } = useTheme();

const mechanism = [
  {
    title: "Ingest local histories",
    detail: "Claude, Cursor, Codex, Copilot, and Gemini conversation traces are scanned locally.",
  },
  {
    title: "Compact and index context",
    detail: "Conversation chunks, project knowledge, fixes, and FAQs are indexed for fast recall.",
  },
  {
    title: "Sync shared behavior",
    detail: "Skills, commands, agents, MCP config, slash commands, and whitelist policy are propagated per tool.",
  },
  {
    title: "Resume instantly",
    detail: "Every session starts with recall-first context and consistent tool posture.",
  },
];

const proofs = [
  {
    title: "Cross-tool continuity",
    body: "Move between assistants without re-briefing. Context stays scoped to the repository.",
  },
  {
    title: "Policy-first sync",
    body: "One shared policy controls scope and category sync per tool with drift visibility.",
  },
  {
    title: "Project/global/hybrid scope",
    body: "Choose where each tool should resolve managed continuity blocks.",
  },
  {
    title: "FAQ as first-class memory",
    body: "Questions and answers persist beside decisions and fixes in .xtctx/knowledge/faqs.",
  },
];

const compatibility = {
  inputs: "Claude Code, Cursor, Codex CLI, Copilot, Gemini",
  outputs: "AGENTS.md, CLAUDE.md, .cursorrules, copilot-instructions, MCP + API",
};
</script>

<template>
  <div class="landing-shell">
    <header class="site-nav shell-panel">
      <a class="brand" href="#top">
        <span>xtctx</span>
        <small>cross-tool continuity orchestrator</small>
      </a>

      <nav aria-label="Primary navigation">
        <a href="#mechanism">How it works</a>
        <a href="#proof">Coverage</a>
        <a href="#quickstart">Quick start</a>
      </nav>

      <div class="site-actions">
        <Button
          :icon="isDark ? 'pi pi-sun' : 'pi pi-moon'"
          :label="isDark ? 'Light' : 'Dark'"
          size="small"
          outlined
          @click="toggleTheme"
        />
        <a href="https://github.com/fstubner/xtctx" target="_blank" rel="noreferrer">
          <Button label="GitHub" icon="pi pi-github" size="small" outlined />
        </a>
      </div>
    </header>

    <section id="top" class="hero shell-panel">
      <div class="hero-copy">
        <Tag value="Local-first orchestration runtime" severity="info" />
        <h1>Resume in any tool instantly.</h1>
        <p>
          xtctx ingests local assistant history, indexes what matters, and synchronizes
          shared behavior so each session starts with the same context.
        </p>

        <div class="hero-actions">
          <a href="#quickstart"><Button label="Run locally" icon="pi pi-play" /></a>
          <a href="http://127.0.0.1:3232/" target="_blank" rel="noreferrer">
            <Button label="Open runtime UI" icon="pi pi-external-link" outlined />
          </a>
        </div>

        <p class="hero-note">Defaults are sync-on. Scope and categories are adjustable per tool.</p>
      </div>

      <aside class="hero-proof">
        <Card class="proof-card">
          <template #title>Session policy</template>
          <template #content>
            <pre><code>npx xtctx init
npx xtctx sync
npx xtctx serve

# before coding
xtctx_search
xtctx_project_knowledge

# after implementation
xtctx_save_decision
xtctx_save_faq</code></pre>
          </template>
        </Card>

        <Card class="proof-card preview-card">
          <template #title>Runtime console</template>
          <template #content>
            <img :src="runtimePreview" alt="xtctx runtime operations console screenshot" />
          </template>
        </Card>
      </aside>
    </section>

    <section id="mechanism" class="section-block shell-panel">
      <div class="section-head">
        <p>Mechanism</p>
        <h2>Ingest -> index -> sync -> resume</h2>
      </div>

      <div class="mechanism-grid">
        <Card v-for="item in mechanism" :key="item.title" class="mechanism-card">
          <template #title>{{ item.title }}</template>
          <template #content>
            <p>{{ item.detail }}</p>
          </template>
        </Card>
      </div>
    </section>

    <section id="proof" class="section-block shell-panel">
      <div class="section-head">
        <p>Capabilities</p>
        <h2>Coverage for cross-assistant continuity</h2>
      </div>

      <div class="proof-grid">
        <Card v-for="item in proofs" :key="item.title" class="proof-feature-card">
          <template #title>{{ item.title }}</template>
          <template #content>
            <p>{{ item.body }}</p>
          </template>
        </Card>
      </div>

      <div class="compat-row">
        <div>
          <p class="compat-label">Inputs</p>
          <p>{{ compatibility.inputs }}</p>
        </div>
        <div>
          <p class="compat-label">Generated outputs</p>
          <p>{{ compatibility.outputs }}</p>
        </div>
      </div>
    </section>

    <section id="quickstart" class="section-block shell-panel">
      <div class="section-head">
        <p>Quick start</p>
        <h2>Init -> Sync -> Serve -> Recall -> Writeback</h2>
      </div>

      <div class="quick-grid">
        <Card class="quick-card">
          <template #title>Install and bootstrap</template>
          <template #content>
            <ol>
              <li>Install dependencies and build runtime + web UI.</li>
              <li>Initialize project-local `.xtctx` policy and memory directories.</li>
              <li>Start API, MCP, and continuity console.</li>
            </ol>
            <pre><code>npm ci
npm --prefix web ci
npm run build

npx xtctx init
npx xtctx sync
npx xtctx serve</code></pre>
          </template>
        </Card>

        <Card class="quick-card">
          <template #title>Daily continuity loop</template>
          <template #content>
            <ol>
              <li>Recall relevant task context before coding.</li>
              <li>Implement with decisions, fixes, and FAQs loaded.</li>
              <li>Write validated outcomes for the next handoff.</li>
            </ol>
            <pre><code># recall
xtctx_search
xtctx_project_knowledge

# writeback
xtctx_save_decision
xtctx_save_error_solution
xtctx_save_faq</code></pre>
          </template>
        </Card>
      </div>
    </section>
  </div>
</template>
