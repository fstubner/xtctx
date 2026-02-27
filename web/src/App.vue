<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink, RouterView } from "vue-router";
import Button from "primevue/button";
import Tag from "primevue/tag";
import Toast from "primevue/toast";
import { apiGet } from "./composables/useApi";
import { useTheme } from "./composables/useTheme";
import type { ContinuityToolsStatusResponse, SourceStatusResponse } from "./types";

interface HealthResponse {
  ok: boolean;
  projectRoot: string;
}

const navItems = [
  { label: "Dashboard", to: "/", icon: "pi pi-home" },
  { label: "Tools", to: "/tools", icon: "pi pi-sitemap" },
  { label: "Search", to: "/search", icon: "pi pi-search" },
  { label: "Knowledge", to: "/knowledge", icon: "pi pi-book" },
  { label: "Sources", to: "/sources", icon: "pi pi-database" },
  { label: "Config", to: "/config", icon: "pi pi-cog" },
] as const;

const { isDark, toggleTheme } = useTheme();

const health = ref<HealthResponse | null>(null);
const sourceStatus = ref<SourceStatusResponse | null>(null);
const continuity = ref<ContinuityToolsStatusResponse | null>(null);

const starter = "xtctx_search -> xtctx_project_knowledge";

const runtimeTag = computed(() => {
  if (!health.value) {
    return { severity: "contrast" as const, label: "runtime pending" };
  }

  return health.value.ok
    ? { severity: "success" as const, label: "runtime healthy" }
    : { severity: "danger" as const, label: "runtime unavailable" };
});

const contextTag = computed(() => {
  if (!sourceStatus.value) {
    return { severity: "contrast" as const, label: "context pending" };
  }

  if (sourceStatus.value.knowledgeRecords === 0) {
    return { severity: "warn" as const, label: "no indexed context" };
  }

  return {
    severity: "info" as const,
    label: `${sourceStatus.value.knowledgeRecords} indexed records`,
  };
});

const continuityTag = computed(() => {
  const tools = continuity.value?.tools ?? [];
  if (tools.length === 0) {
    return { severity: "contrast" as const, label: "sync unavailable" };
  }

  const drifted = tools.filter(
    (tool) => tool.enabled && (tool.state === "drifted" || tool.state === "missing_target"),
  );
  if (drifted.length > 0) {
    return { severity: "warn" as const, label: `${drifted.length} tool warnings` };
  }

  return { severity: "success" as const, label: "tool sync aligned" };
});

const projectRoot = computed(() => health.value?.projectRoot ?? "Project root unavailable");

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
  <div class="app-shell">
    <Toast position="top-right" />

    <header class="shell-header shell-panel">
      <div class="header-brand">
        <p class="eyebrow">xtctx runtime</p>
        <h1>Continuity operations</h1>
        <p>
          Recall context before edits, keep tool behavior aligned, and write validated
          outcomes back to project memory.
        </p>
      </div>

      <div class="header-status">
        <Tag :severity="runtimeTag.severity" :value="runtimeTag.label" />
        <Tag :severity="contextTag.severity" :value="contextTag.label" />
        <Tag :severity="continuityTag.severity" :value="continuityTag.label" />
        <Button
          :icon="isDark ? 'pi pi-sun' : 'pi pi-moon'"
          :label="isDark ? 'Light' : 'Dark'"
          size="small"
          outlined
          @click="toggleTheme"
        />
      </div>
    </header>

    <section class="shell-context shell-panel">
      <div>
        <p class="eyebrow">Project root</p>
        <code>{{ projectRoot }}</code>
      </div>
      <div>
        <p class="eyebrow">Session opener</p>
        <code>{{ starter }}</code>
      </div>
      <div class="shell-context-links">
        <a href="/health" target="_blank" rel="noreferrer">Health</a>
        <a href="/api/sources" target="_blank" rel="noreferrer">Sources API</a>
      </div>
    </section>

    <nav class="shell-nav shell-panel" aria-label="Primary navigation">
      <div class="shell-nav-items">
        <RouterLink
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          custom
          v-slot="{ href, navigate, isActive }"
        >
          <a
            :href="href"
            class="nav-item"
            :class="{ active: isActive }"
            @click="navigate"
          >
            <i :class="item.icon" />
            <span>{{ item.label }}</span>
          </a>
        </RouterLink>
      </div>

      <RouterLink to="/search" custom v-slot="{ navigate }">
        <Button label="Start recall" icon="pi pi-bolt" @click="navigate" />
      </RouterLink>
    </nav>

    <main class="workspace-main shell-panel">
      <RouterView />
    </main>
  </div>
</template>
