<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
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
  { label: "Activity", to: "/activity" },
  { label: "Memory", to: "/memory" },
] as const;

const { isDark, toggleTheme } = useTheme();
const route = useRoute();

const health = ref<HealthResponse | null>(null);
const sourceStatus = ref<SourceStatusResponse | null>(null);
const continuity = ref<ContinuityToolsStatusResponse | null>(null);
const sidebarCollapsed = ref(false);

const driftedCount = computed(() => {
  const tools = continuity.value?.tools ?? [];
  return tools.filter((t) => t.enabled && (t.state === "drifted" || t.state === "missing_target")).length;
});

const projectRoot = computed(() => health.value?.projectRoot ?? "Project root unavailable");
const projectLabel = computed(() => {
  const normalized = projectRoot.value.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  const leaf = segments.length > 0 ? segments[segments.length - 1] : "";
  return leaf || "xtctx";
});

const enabledSourceCount = computed(() => {
  const scrapers = sourceStatus.value?.scrapers ?? [];
  return scrapers.filter((scraper) => scraper.enabled).length;
});

const detectedSourceCount = computed(() => {
  const scrapers = sourceStatus.value?.scrapers ?? [];
  return scrapers.filter((scraper) => scraper.enabled && scraper.detected).length;
});

const runtimePill = computed<StatusPill>(() => {
  if (!health.value) return { label: "runtime pending", tone: "neutral" };
  return health.value.ok
    ? { label: "runtime healthy", tone: "ok" }
    : { label: "runtime unavailable", tone: "danger" };
});

const contextPill = computed<StatusPill>(() => {
  if (!sourceStatus.value) return { label: "context pending", tone: "neutral" };
  if (sourceStatus.value.knowledgeRecords === 0) return { label: "no context", tone: "warn" };
  return { label: `${sourceStatus.value.knowledgeRecords} indexed`, tone: "ok" };
});

const syncPill = computed<StatusPill>(() => {
  const tools = continuity.value?.tools ?? [];
  if (tools.length === 0) return { label: "sync pending", tone: "neutral" };
  if (driftedCount.value > 0) return { label: `${driftedCount.value} warnings`, tone: "warn" };
  return { label: "sync aligned", tone: "ok" };
});

function pillClass(pill: StatusPill): string {
  if (pill.tone === "ok") return "xt-chip-ok";
  if (pill.tone === "warn") return "xt-chip-warn";
  if (pill.tone === "danger") return "xt-chip-danger";
  return "xt-chip-neutral";
}

function isNavActive(to: string): boolean {
  if (to === "/") return route.path === "/";
  return route.path.startsWith(to);
}

function toggleSidebar(): void {
  sidebarCollapsed.value = !sidebarCollapsed.value;
  localStorage.setItem("xtctx:sidebar-collapsed", String(sidebarCollapsed.value));
}

onMounted(async () => {
  sidebarCollapsed.value = localStorage.getItem("xtctx:sidebar-collapsed") === "true";

  const [healthRes, sourceRes, continuityRes] = await Promise.allSettled([
    apiGet<HealthResponse>("/health"),
    apiGet<SourceStatusResponse>("/api/sources/status"),
    apiGet<ContinuityToolsStatusResponse>("/api/continuity/tools-status"),
  ]);

  if (healthRes.status === "fulfilled") health.value = healthRes.value;
  if (sourceRes.status === "fulfilled") sourceStatus.value = sourceRes.value;
  if (continuityRes.status === "fulfilled") continuity.value = continuityRes.value;
});
</script>

<template>
  <div class="xt-app">
    <!-- Topbar: full-width, 48px, border-bottom only -->
    <header class="xt-topbar">
      <button
        class="xt-sidebar-toggle"
        type="button"
        :aria-label="sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
        @click="toggleSidebar"
      >
        <span class="xt-sidebar-toggle-icon" :class="{ 'is-collapsed': sidebarCollapsed }" />
      </button>

      <div class="xt-brand">
        <div class="xt-brand-mark">xt</div>
        <span class="xt-brand-name">xtctx</span>
      </div>

      <div class="ml-auto flex items-center gap-4">
        <span :class="pillClass(runtimePill)">{{ runtimePill.label }}</span>
        <span :class="pillClass(contextPill)">{{ contextPill.label }}</span>
        <span :class="pillClass(syncPill)">{{ syncPill.label }}</span>
        <div class="h-4 w-px" style="background: hsl(var(--border))" aria-hidden="true" />
        <button class="text-xs text-muted transition-colors hover:text-text" type="button" @click="toggleTheme">
          {{ isDark ? "Light" : "Dark" }}
        </button>
      </div>
    </header>

    <!-- Mobile nav: horizontal tab strip, hidden on md+ -->
    <nav class="xt-mobile-nav" aria-label="Primary navigation">
      <RouterLink
        v-for="item in navItems"
        :key="item.to"
        :to="item.to"
        custom
        v-slot="{ href, navigate }"
      >
        <a
          :href="href"
          class="xt-mnav-link"
          :class="{ 'xt-mnav-link-active': isNavActive(item.to) }"
          @click="navigate"
        >
          {{ item.label }}
        </a>
      </RouterLink>
    </nav>

    <div class="xt-body">
      <!-- Sidebar: desktop only, collapsible -->
      <aside
        class="xt-sidebar"
        :class="{ 'xt-sidebar-collapsed': sidebarCollapsed }"
        aria-label="Primary navigation"
      >
        <div class="xt-sidebar-header">
          <p class="xt-eyebrow">Cross-tool context management</p>
          <p class="xt-sidebar-project">{{ projectLabel }}</p>
        </div>

        <nav class="xt-sidebar-nav">
          <RouterLink
            v-for="item in navItems"
            :key="item.to"
            :to="item.to"
            custom
            v-slot="{ href, navigate }"
          >
            <a
              :href="href"
              class="xt-nav-link"
              :class="{ 'xt-nav-link-active': isNavActive(item.to) }"
              @click="navigate"
            >
              {{ item.label }}
            </a>
          </RouterLink>
        </nav>

        <div class="xt-sidebar-footer">
          <div class="xt-sidebar-card">
            <p class="xt-eyebrow">Workspace</p>
            <p class="xt-sidebar-path">{{ projectRoot }}</p>
            <dl class="xt-sidebar-meta">
              <div>
                <dt>Sources</dt>
                <dd>{{ detectedSourceCount }}/{{ enabledSourceCount || "0" }}</dd>
              </div>
              <div>
                <dt>Tool drift</dt>
                <dd>{{ driftedCount }}</dd>
              </div>
            </dl>
          </div>
        </div>
      </aside>

      <!-- Main content -->
      <main class="xt-content">
        <RouterView />
      </main>
    </div>
  </div>
</template>
