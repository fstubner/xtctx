<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
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
const router = useRouter();
const route = useRoute();

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
const activeSectionLabel = computed(
  () => navItems.find((item) => item.to === route.path)?.label ?? "Workspace",
);

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
    <aside class="xt-panel rt-sidebar">
      <div class="space-y-1">
        <h1 class="rt-brand-title">xtctx</h1>
        <p class="rt-brand-subtitle">cross tool context management</p>
      </div>

      <nav class="rt-nav" aria-label="Primary navigation">
        <p class="xt-eyebrow">Navigation</p>
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
      </nav>

      <section class="rt-info-block">
        <p class="xt-eyebrow">Project root</p>
        <code>{{ projectRoot }}</code>
      </section>

      <div class="mt-auto space-y-2">
        <div class="rt-toolbar">
          <a class="xt-btn-ghost" href="/health" target="_blank" rel="noreferrer">Health</a>
          <a class="xt-btn-ghost" href="/api/sources" target="_blank" rel="noreferrer">Sources API</a>
        </div>
        <button class="xt-btn w-full" type="button" @click="router.push('/search')">Start recall</button>
      </div>
    </aside>

    <section class="rt-main">
      <header class="xt-panel rt-topbar">
        <div class="space-y-1">
          <p class="xt-eyebrow">xtctx runtime</p>
          <h2 class="rt-topbar-title">{{ activeSectionLabel }}</h2>
          <p class="text-sm text-muted">Local app shell for cross-tool context operations.</p>
        </div>

        <div class="rt-toolbar">
          <span :class="pillClass(runtimePill)">{{ runtimePill.label }}</span>
          <span :class="pillClass(contextPill)">{{ contextPill.label }}</span>
          <span :class="pillClass(syncPill)">{{ syncPill.label }}</span>
          <button class="xt-btn-ghost" type="button" @click="toggleTheme">
            {{ isDark ? "Light" : "Dark" }}
          </button>
        </div>
      </header>

      <section class="xt-panel rt-contextbar">
        <div class="rt-info-block">
          <p class="xt-eyebrow">Project root</p>
          <code>{{ projectRoot }}</code>
        </div>
        <div class="rt-info-block">
          <p class="xt-eyebrow">Session opener</p>
          <code>{{ starter }}</code>
        </div>
        <div class="rt-info-block">
          <p class="xt-eyebrow">Quick actions</p>
          <div class="rt-toolbar">
            <button class="xt-btn-ghost" type="button" @click="router.push('/search')">Open search</button>
            <button class="xt-btn-ghost" type="button" @click="router.push('/knowledge')">Open knowledge</button>
          </div>
        </div>
      </section>

      <main class="xt-panel rt-content">
        <RouterView />
      </main>
    </section>
  </div>
</template>
