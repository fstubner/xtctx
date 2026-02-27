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

interface SectionMeta {
  title: string;
  subtitle: string;
}

const navItems = [
  { label: "Dashboard", to: "/" },
  { label: "Tools", to: "/tools" },
  { label: "Search", to: "/search" },
  { label: "Knowledge", to: "/knowledge" },
  { label: "Sources", to: "/sources" },
  { label: "Config", to: "/config" },
] as const;

const defaultSection: SectionMeta = {
  title: "Dashboard",
  subtitle: "Check continuity posture, clear blockers, and start recall with one stable session flow.",
};

const sectionMeta: Record<string, SectionMeta> = {
  "/": {
    title: "Dashboard",
    subtitle: "Check continuity posture, clear blockers, and start recall with one stable session flow.",
  },
  "/tools": {
    title: "Tools",
    subtitle: "Manage per-tool sync scope and category propagation, then reconcile drifted targets.",
  },
  "/search": {
    title: "Search",
    subtitle: "Retrieve relevant session context before editing so implementation starts with constraints in scope.",
  },
  "/knowledge": {
    title: "Knowledge",
    subtitle: "Load decisions, fixes, conventions, and FAQs that should shape this session.",
  },
  "/sources": {
    title: "Sources",
    subtitle: "Verify ingestion coverage and session indexing health across your assistant tools.",
  },
  "/config": {
    title: "Config",
    subtitle: "Inspect effective policy and rendered tool outputs managed by xtctx sync.",
  },
};

const { isDark, toggleTheme } = useTheme();
const router = useRouter();
const route = useRoute();

const health = ref<HealthResponse | null>(null);
const sourceStatus = ref<SourceStatusResponse | null>(null);
const continuity = ref<ContinuityToolsStatusResponse | null>(null);
const starter = "xtctx_search -> xtctx_project_knowledge";

const activeSection = computed<SectionMeta>(() => {
  return sectionMeta[route.path] ?? defaultSection;
});

const driftedCount = computed(() => {
  const tools = continuity.value?.tools ?? [];
  return tools.filter((tool) => tool.enabled && (tool.state === "drifted" || tool.state === "missing_target"))
    .length;
});

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
    return { label: "tool sync unavailable", tone: "neutral" };
  }

  if (driftedCount.value > 0) {
    return { label: `${driftedCount.value} tool warnings`, tone: "warn" };
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

      <section class="xt-card space-y-3">
        <p class="xt-eyebrow">Daily loop</p>
        <ol class="space-y-1 text-sm leading-relaxed text-muted">
          <li>1. Recall task context.</li>
          <li>2. Load knowledge and FAQs.</li>
          <li>3. Implement and verify.</li>
          <li>4. Write back validated outcomes.</li>
        </ol>
      </section>

      <div class="mt-auto space-y-2">
        <div class="rt-toolbar">
          <a class="xt-btn-ghost" href="/health" target="_blank" rel="noreferrer">Health</a>
          <a class="xt-btn-ghost" href="/api/sources" target="_blank" rel="noreferrer">Sources API</a>
        </div>
      </div>
    </aside>

    <section class="rt-main">
      <header class="xt-panel rt-header">
        <div class="space-y-1">
          <p class="xt-eyebrow">xtctx runtime</p>
          <h2 class="rt-topbar-title">{{ activeSection.title }}</h2>
          <p class="text-sm text-muted">{{ activeSection.subtitle }}</p>
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

      <section class="xt-panel rt-session-strip">
        <div class="rt-strip-item">
          <p class="xt-eyebrow">Project root</p>
          <code>{{ projectRoot }}</code>
        </div>
        <div class="rt-strip-item">
          <p class="xt-eyebrow">Session opener</p>
          <code>{{ starter }}</code>
        </div>
        <div class="rt-strip-actions">
          <button class="xt-btn-ghost" type="button" @click="router.push('/search')">Open search</button>
          <button class="xt-btn-ghost" type="button" @click="router.push('/knowledge')">Open knowledge</button>
          <button class="xt-btn" type="button" @click="router.push('/search')">Start recall</button>
        </div>
      </section>

      <main class="xt-panel rt-content">
        <RouterView />
      </main>
    </section>
  </div>
</template>
