<script setup lang="ts">
import { useTheme } from "./composables/useTheme";
import runtimePreview from "./assets/runtime-screenshot.png";

const { isDark, toggleTheme } = useTheme();

const mechanism = [
  {
    title: "Ingest local history",
    detail: "Collect conversation traces from tools you use and index them locally per repository.",
  },
  {
    title: "Normalize continuity memory",
    detail: "Keep decisions, fixes, and FAQs in one searchable project memory layer.",
  },
  {
    title: "Sync tool behavior",
    detail: "Propagate skills, commands, agents, MCP settings, and policy blocks across assistants.",
  },
  {
    title: "Resume in another tool",
    detail: "Start each session with recall-first context and consistent tool posture.",
  },
];

const capabilities = [
  "Cross-tool context continuity scoped to a codebase",
  "Per-tool project/global/hybrid scope controls",
  "Drift visibility for managed continuity targets",
  "FAQ as first-class knowledge beside decisions and fixes",
];
</script>

<template>
  <div class="lp-shell">
    <header class="lp-panel flex flex-wrap items-center justify-between gap-4 px-6 py-4">
      <a href="#top" class="space-y-1">
        <p class="text-4xl font-semibold tracking-[-0.02em]" style="font-family: 'Sora', 'Manrope', sans-serif">xtctx</p>
        <p class="lp-eyebrow">Cross-tool continuity orchestrator</p>
      </a>

      <nav class="flex flex-wrap gap-2 text-sm font-semibold text-muted">
        <a class="lp-btn-ghost" href="#mechanism">Mechanism</a>
        <a class="lp-btn-ghost" href="#capabilities">Capabilities</a>
        <a class="lp-btn-ghost" href="#quickstart">Quick start</a>
      </nav>

      <div class="flex flex-wrap gap-2">
        <button class="lp-btn-ghost" type="button" @click="toggleTheme">{{ isDark ? "Light" : "Dark" }}</button>
        <a class="lp-btn-ghost" href="https://github.com/fstubner/xtctx" target="_blank" rel="noreferrer">GitHub</a>
      </div>
    </header>

    <section id="top" class="lp-panel grid gap-6 px-6 py-8 md:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] md:px-8 md:py-10">
      <div class="space-y-5">
        <p class="lp-eyebrow">Local-first continuity runtime</p>
        <h1 class="lp-hero-title">Resume in any coding assistant without re-briefing.</h1>
        <p class="max-w-2xl text-lg leading-relaxed lp-muted">
          xtctx keeps project context portable by combining local history ingestion, searchable memory,
          and policy-driven sync outputs for every assistant you use.
        </p>

        <div class="flex flex-wrap gap-2">
          <a class="lp-btn" href="#quickstart">Run locally</a>
          <a class="lp-btn-ghost" href="http://127.0.0.1:3232/" target="_blank" rel="noreferrer">Open runtime UI</a>
        </div>

        <div class="flex flex-wrap gap-2">
          <span class="lp-pill">Local runtime process</span>
          <span class="lp-pill">Project-scoped memory</span>
          <span class="lp-pill">Policy-first sync</span>
        </div>
      </div>

      <div class="space-y-4">
        <article class="lp-card space-y-3">
          <p class="lp-eyebrow">Session policy</p>
          <pre class="overflow-x-auto rounded-lg border bg-surface p-4 text-xs leading-relaxed">npx xtctx init
npx xtctx sync
npx xtctx serve

# before coding
xtctx_search
xtctx_project_knowledge

# after implementation
xtctx_save_decision
xtctx_save_faq</pre>
        </article>

        <article class="lp-card space-y-3">
          <p class="lp-eyebrow">Runtime preview</p>
          <img :src="runtimePreview" alt="xtctx runtime console screenshot" class="w-full rounded-lg border" />
        </article>
      </div>
    </section>

    <section id="mechanism" class="lp-panel space-y-5 px-6 py-7 md:px-8 md:py-8">
      <header class="space-y-2">
        <p class="lp-eyebrow">Mechanism</p>
        <h2 class="lp-h2">Ingest -> Index -> Sync -> Resume</h2>
      </header>

      <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <article v-for="item in mechanism" :key="item.title" class="lp-card space-y-2">
          <h3 class="text-xl font-semibold" style="font-family: 'Sora', 'Manrope', sans-serif">{{ item.title }}</h3>
          <p class="text-base leading-relaxed lp-muted">{{ item.detail }}</p>
        </article>
      </div>
    </section>

    <section id="capabilities" class="lp-panel space-y-5 px-6 py-7 md:px-8 md:py-8">
      <header class="space-y-2">
        <p class="lp-eyebrow">Capabilities</p>
        <h2 class="lp-h2">Purpose-built for cross-tool continuity operations</h2>
      </header>

      <div class="grid gap-4 md:grid-cols-2">
        <article v-for="item in capabilities" :key="item" class="lp-card">
          <p class="text-base leading-relaxed">{{ item }}</p>
        </article>
      </div>

      <div class="grid gap-4 rounded-xl border bg-surface-2 p-5 md:grid-cols-2">
        <div>
          <p class="lp-eyebrow">Inputs</p>
          <p class="mt-2 text-base leading-relaxed">Claude Code, Cursor, Codex CLI, Copilot, Gemini</p>
        </div>
        <div>
          <p class="lp-eyebrow">Generated outputs</p>
          <p class="mt-2 text-base leading-relaxed">AGENTS.md, CLAUDE.md, .cursorrules, copilot instructions, MCP + API</p>
        </div>
      </div>
    </section>

    <section id="quickstart" class="lp-panel space-y-5 px-6 py-7 md:px-8 md:py-8">
      <header class="space-y-2">
        <p class="lp-eyebrow">Quick start</p>
        <h2 class="lp-h2">Init -> Sync -> Serve -> Recall -> Writeback</h2>
      </header>

      <div class="grid gap-4 xl:grid-cols-2">
        <article class="lp-card space-y-3">
          <h3 class="text-xl font-semibold" style="font-family: 'Sora', 'Manrope', sans-serif">Install and bootstrap</h3>
          <ol class="list-decimal space-y-2 pl-5 text-base leading-relaxed lp-muted">
            <li>Install dependencies and build runtime assets.</li>
            <li>Initialize project-local continuity policy and memory folders.</li>
            <li>Start API, MCP, and runtime console.</li>
          </ol>
          <pre class="overflow-x-auto rounded-lg border bg-surface p-4 text-xs leading-relaxed">npm ci
npm --prefix web ci
npm run build

npx xtctx init
npx xtctx sync
npx xtctx serve</pre>
        </article>

        <article class="lp-card space-y-3">
          <h3 class="text-xl font-semibold" style="font-family: 'Sora', 'Manrope', sans-serif">Daily continuity loop</h3>
          <ol class="list-decimal space-y-2 pl-5 text-base leading-relaxed lp-muted">
            <li>Recall relevant context before coding.</li>
            <li>Implement with decisions and FAQs loaded.</li>
            <li>Write validated outcomes for the next handoff.</li>
          </ol>
          <pre class="overflow-x-auto rounded-lg border bg-surface p-4 text-xs leading-relaxed"># recall
xtctx_search
xtctx_project_knowledge

# writeback
xtctx_save_decision
xtctx_save_error_solution
xtctx_save_faq</pre>
        </article>
      </div>
    </section>
  </div>
</template>
