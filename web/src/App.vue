<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink, RouterView } from "vue-router";
import { apiGet } from "./composables/useApi";
import { useTheme } from "./composables/useTheme";
import type { ContinuityToolsStatusResponse, SourceStatusResponse } from "./types";

interface HealthResponse {
  ok: boolean;
  projectRoot: string;
}

interface StatusPill {
  label: string;
  tone: "neutral" | "ok" | "warn" | "danger";
}

const navItems = [
  { label: "Dashboard", to: "/" },
  { label: "Tools", to: "/tools" },
  { label: "Search", to: "/search" },
  { label: "Knowledge", to: "/knowledge" },
  { label: "Sources", to: "/sources" },
  { label: "Config", to: "/config" },
] as const;

const { isDark, toggleTheme } = useTheme();

const health = ref<HealthResponse | null>(null);
const sourceStatus = ref<SourceStatusResponse | null>(null);
const continuity = ref<ContinuityToolsStatusResponse | null>(null);
const starter = "xtctx_search -> xtctx_project_knowledge";

const runtimePill = computed<StatusPill>(() => {
  if (!health.value) {
    return { label: "runtime pending", tone: "neutral" };
  }

  return health.value.ok
    ? { label: "runtime healthy", tone: "ok" }
    : { label: "runtime unavailable", tone: "danger" };
});

const contextPill = computed<StatusPill>(() => {
  if (!sourceStatus.value) {
    return { label: "context pending", tone: "neutral" };
  }

  if (sourceStatus.value.knowledgeRecords === 0) {
    return { label: "no indexed context", tone: "warn" };
  }

  return { label: `${sourceStatus.value.knowledgeRecords} indexed records`, tone: "ok" };
});

const syncPill = computed<StatusPill>(() => {
  const tools = continuity.value?.tools ?? [];

  if (tools.length === 0) {
    return { label: "sync unavailable", tone: "neutral" };
  }

  const driftedCount = tools.filter(
    (tool) => tool.enabled && (tool.state === "drifted" || tool.state === "missing_target"),
  ).length;

  if (driftedCount > 0) {
    return { label: `${driftedCount} tool warnings`, tone: "warn" };
  }

  return { label: "tool sync aligned", tone: "ok" };
});

const projectRoot = computed(() => health.value?.projectRoot ?? "Project root unavailable");

function pillClass(pill: StatusPill): string {
  if (pill.tone === "ok") {
    return "xt-chip-ok";
  }

  if (pill.tone === "warn") {
    return "xt-chip-warn";
  }

  if (pill.tone === "danger") {
    return "xt-chip-danger";
  }

  return "xt-chip-neutral";
}

onMounted(async () => {
  const [healthResponse, sourceResponse, continuityResponse] = await Promise.allSettled([
    apiGet<HealthResponse>("/health"),
    apiGet<SourceStatusResponse>("/api/sources/status"),
    apiGet<ContinuityToolsStatusResponse>("/api/continuity/tools-status"),
  ]);

  if (healthResponse.status === "fulfilled") {
    health.value = healthResponse.value;
  }

  if (sourceResponse.status === "fulfilled") {
    sourceStatus.value = sourceResponse.value;
  }

  if (continuityResponse.status === "fulfilled") {
    continuity.value = continuityResponse.value;
  }
});
</script>

<template>
  <div class="xt-shell">
    <header class="xt-panel px-6 py-6 md:px-8 md:py-7">
      <div class="grid gap-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
        <div class="space-y-3">
          <p class="xt-eyebrow">xtctx continuity runtime</p>
          <h1 class="xt-headline">Cross-tool continuity console</h1>
          <p class="max-w-3xl text-lg leading-relaxed text-muted">
            Keep each coding session consistent: recover context before edits, keep tool policy aligned,
            then write validated outcomes for handoff.
          </p>
        </div>

        <div class="flex flex-wrap items-start justify-start gap-2 md:justify-end">
          <span :class="pillClass(runtimePill)">{{ runtimePill.label }}</span>
          <span :class="pillClass(contextPill)">{{ contextPill.label }}</span>
          <span :class="pillClass(syncPill)">{{ syncPill.label }}</span>
          <button class="xt-btn-ghost" type="button" @click="toggleTheme">
            {{ isDark ? "Light" : "Dark" }}
          </button>
        </div>
      </div>
    </header>

    <section class="xt-panel px-6 py-5 md:px-8">
      <div class="grid gap-5 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_auto] md:items-end">
        <div class="space-y-2">
          <p class="xt-eyebrow">Project root</p>
          <code class="block overflow-hidden text-ellipsis whitespace-nowrap text-sm md:text-base">{{ projectRoot }}</code>
        </div>

        <div class="space-y-2">
          <p class="xt-eyebrow">Session opener</p>
          <code class="block text-sm md:text-base">{{ starter }}</code>
        </div>

        <div class="flex flex-wrap gap-2">
          <a class="xt-btn-ghost" href="/health" target="_blank" rel="noreferrer">Health</a>
          <a class="xt-btn-ghost" href="/api/sources" target="_blank" rel="noreferrer">Sources API</a>
        </div>
      </div>
    </section>

    <nav class="xt-panel flex flex-col gap-4 px-4 py-4 md:flex-row md:items-center md:justify-between md:px-6" aria-label="Primary navigation">
      <div class="flex flex-wrap gap-2">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          custom
          v-slot="{ href, navigate, isActive }"
        >
          <a
            :href="href"
            class="xt-nav-link"
            :class="{ 'xt-nav-link-active': isActive }"
            @click="navigate"
          >
            {{ item.label }}
          </a>
        </RouterLink>
      </div>

      <RouterLink to="/search" custom v-slot="{ navigate }">
        <button class="xt-btn" type="button" @click="navigate">Start recall</button>
      </RouterLink>
    </nav>

    <main class="xt-panel p-6 md:p-8">
      <RouterView />
    </main>
  </div>
</template>
