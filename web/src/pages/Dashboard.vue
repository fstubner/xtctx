<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { apiGet, apiPost } from "../composables/useApi";
import type {
  ContinuitySyncResult,
  ContinuityToolsStatusResponse,
  ContinuityWarningsResponse,
  SourceStatusResponse,
} from "../types";

const loading = ref(true);
const error = ref("");
const status = ref<SourceStatusResponse | null>(null);
const continuity = ref<ContinuityToolsStatusResponse | null>(null);
const warnings = ref<ContinuityWarningsResponse | null>(null);
const syncing = ref(false);
const flash = ref("");

const enabledSources = computed(
  () => status.value?.scrapers.filter((scraper) => scraper.enabled).length ?? 0,
);
const detectedSources = computed(
  () => status.value?.scrapers.filter((scraper) => scraper.enabled && scraper.detected).length ?? 0,
);
const enabledTools = computed(
  () => continuity.value?.tools.filter((tool) => tool.enabled).length ?? 0,
);
const inSyncTools = computed(
  () => continuity.value?.tools.filter((tool) => tool.enabled && tool.state === "in_sync").length ?? 0,
);
const warningCount = computed(() => warnings.value?.count ?? 0);
const indexedRecords = computed(() => status.value?.knowledgeRecords ?? 0);

const postureLabel = computed(() => {
  if (loading.value) return "loading";
  if (error.value) return "degraded";
  if (warningCount.value > 0 || detectedSources.value < enabledSources.value) return "attention needed";
  return "healthy";
});

const postureClass = computed(() => {
  if (loading.value) return "xt-chip-neutral";
  if (error.value) return "xt-chip-danger";
  if (warningCount.value > 0 || detectedSources.value < enabledSources.value) return "xt-chip-warn";
  return "xt-chip-ok";
});

const issues = computed(() => {
  const items: Array<{ title: string; detail: string; action: string; route: string }> = [];

  if (enabledSources.value === 0) {
    items.push({
      title: "No ingestion sources enabled",
      detail: "Enable at least one source path so conversation history can be ingested.",
      action: "Configure sources",
      route: "/sources",
    });
  } else if (detectedSources.value < enabledSources.value) {
    items.push({
      title: "Some enabled sources are not detected",
      detail: `${detectedSources.value} of ${enabledSources.value} enabled source paths are currently available.`,
      action: "Review source paths",
      route: "/sources",
    });
  }

  if (warningCount.value > 0) {
    items.push({
      title: "Tool sync drift detected",
      detail: `${warningCount.value} warning${warningCount.value > 1 ? "s" : ""} require reconciliation.`,
      action: "Open tools",
      route: "/tools",
    });
  }

  if (indexedRecords.value === 0) {
    items.push({
      title: "No indexed context records",
      detail: "Ingestion is connected but no context records are currently indexed.",
      action: "Inspect ingestion activity",
      route: "/activity",
    });
  }

  return items;
});

onMounted(async () => {
  await refresh();
});

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = "";
  flash.value = "";

  const [statusPayload, continuityPayload, warningsPayload] = await Promise.allSettled([
    apiGet<SourceStatusResponse>("/api/sources/status"),
    apiGet<ContinuityToolsStatusResponse>("/api/continuity/tools-status"),
    apiGet<ContinuityWarningsResponse>("/api/continuity/warnings"),
  ]);

  if (statusPayload.status === "fulfilled") {
    status.value = statusPayload.value;
  }

  if (continuityPayload.status === "fulfilled") {
    continuity.value = continuityPayload.value;
  } else {
    error.value = "Tool sync status is unavailable.";
  }

  if (warningsPayload.status === "fulfilled") {
    warnings.value = warningsPayload.value;
  }

  loading.value = false;
}

async function syncAllTools(): Promise<void> {
  syncing.value = true;
  error.value = "";
  flash.value = "";

  try {
    const result = await apiPost<ContinuitySyncResult>("/api/continuity/sync", {});
    flash.value = `Sync complete: ${result.updated} updated, ${result.created} created, ${result.unchanged} unchanged.`;
    await refresh();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    syncing.value = false;
  }
}
</script>

<template>
  <section class="space-y-6">
    <header class="space-y-3">
      <p class="xt-eyebrow">Control plane health</p>
      <h2 class="xt-title">Automation overview</h2>
      <p class="max-w-3xl text-base leading-relaxed text-muted">
        Monitor ingestion and tool sync automation. Use this page to detect drift and dispatch fixes.
      </p>
    </header>

    <div class="xt-card space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h3 class="xt-section-title text-xl">System posture</h3>
        <span :class="postureClass">{{ postureLabel }}</span>
      </div>

      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <article class="xt-kpi">
          <p class="xt-kpi-value">{{ detectedSources }} / {{ enabledSources }}</p>
          <p class="xt-kpi-label">Detected sources</p>
        </article>
        <article class="xt-kpi">
          <p class="xt-kpi-value">{{ inSyncTools }} / {{ enabledTools }}</p>
          <p class="xt-kpi-label">Tools in sync</p>
        </article>
        <article class="xt-kpi">
          <p class="xt-kpi-value">{{ indexedRecords }}</p>
          <p class="xt-kpi-label">Indexed records</p>
        </article>
        <article class="xt-kpi">
          <p class="xt-kpi-value">{{ warningCount }}</p>
          <p class="xt-kpi-label">Active warnings</p>
        </article>
      </div>
    </div>

    <div v-if="error" class="xt-alert-danger">{{ error }}</div>
    <div v-if="flash" class="xt-alert-ok">{{ flash }}</div>

    <div class="grid gap-4 xl:grid-cols-2">
      <section class="xt-card space-y-4">
        <h3 class="xt-section-title text-xl">Open issues</h3>
        <p v-if="issues.length === 0" class="text-sm text-muted">
          No critical blockers detected. Continue monitoring activity and run manual sync after policy changes.
        </p>
        <ul v-else class="space-y-3">
          <li
            v-for="item in issues"
            :key="item.title"
            class="rounded-lg border bg-surface p-3"
          >
            <p class="font-semibold">{{ item.title }}</p>
            <p class="mt-1 text-sm text-muted">{{ item.detail }}</p>
            <RouterLink :to="item.route" custom v-slot="{ navigate }">
              <button class="xt-btn-ghost mt-3" type="button" @click="navigate">{{ item.action }}</button>
            </RouterLink>
          </li>
        </ul>
      </section>

      <section class="xt-card space-y-4">
        <h3 class="xt-section-title text-xl">Automation actions</h3>
        <p class="text-sm leading-relaxed text-muted">
          Manual operations are optional but useful after changing tool policy or source configuration.
        </p>

        <div class="flex flex-wrap gap-2">
          <button class="xt-btn" type="button" :disabled="syncing" @click="syncAllTools">
            {{ syncing ? "Syncing..." : "Run sync all tools" }}
          </button>
          <RouterLink to="/sources" custom v-slot="{ navigate }">
            <button class="xt-btn-ghost" type="button" @click="navigate">Manage sources</button>
          </RouterLink>
          <RouterLink to="/tools" custom v-slot="{ navigate }">
            <button class="xt-btn-ghost" type="button" @click="navigate">Manage tools</button>
          </RouterLink>
          <RouterLink to="/activity" custom v-slot="{ navigate }">
            <button class="xt-btn-ghost" type="button" @click="navigate">Open activity</button>
          </RouterLink>
        </div>

        <button class="xt-btn-ghost" type="button" @click="refresh">Refresh status</button>
      </section>
    </div>
  </section>
</template>
