<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { apiGet } from "../composables/useApi";
import type {
  ContinuityToolsStatusResponse,
  ContinuityWarningsResponse,
  SourceStatusResponse,
  SourcesResponse,
} from "../types";

const loading = ref(true);
const error = ref("");
const sourcesStatus = ref<SourceStatusResponse | null>(null);
const sources = ref<SourcesResponse | null>(null);
const continuity = ref<ContinuityToolsStatusResponse | null>(null);
const warnings = ref<ContinuityWarningsResponse | null>(null);

const inSyncTools = computed(
  () => continuity.value?.tools.filter((tool) => tool.state === "in_sync" && tool.enabled).length ?? 0,
);

const connectedSources = computed(() => sourcesStatus.value?.connectedSources ?? 0);
const indexedRecords = computed(() => sourcesStatus.value?.knowledgeRecords ?? 0);
const sessionsCount = computed(() => sources.value?.sessions.length ?? 0);
const warningCount = computed(() => warnings.value?.count ?? 0);

const readinessText = computed(() => {
  if (!sourcesStatus.value || !continuity.value) {
    return "Loading continuity posture...";
  }

  if (warningCount.value > 0) {
    return `Continuity warnings detected (${warningCount.value}). Review tool drift and reconcile.`;
  }

  if (!sourcesStatus.value.toolPortabilityReady) {
    return "No tool histories are detected yet. Configure scraper paths before relying on handoff recall.";
  }

  return "Continuity posture is healthy. Start with recall, then write back validated outcomes.";
});

const readinessClass = computed(() => {
  if (!sourcesStatus.value || !continuity.value) {
    return "xt-alert-warn";
  }

  if (warningCount.value > 0) {
    return "xt-alert-warn";
  }

  return sourcesStatus.value.toolPortabilityReady ? "xt-alert-ok" : "xt-alert-warn";
});

onMounted(async () => {
  loading.value = true;

  const [statusPayload, sourcePayload, continuityPayload, warningsPayload] = await Promise.allSettled([
    apiGet<SourceStatusResponse>("/api/sources/status"),
    apiGet<SourcesResponse>("/api/sources"),
    apiGet<ContinuityToolsStatusResponse>("/api/continuity/tools-status"),
    apiGet<ContinuityWarningsResponse>("/api/continuity/warnings"),
  ]);

  if (statusPayload.status === "fulfilled") {
    sourcesStatus.value = statusPayload.value;
  }

  if (sourcePayload.status === "fulfilled") {
    sources.value = sourcePayload.value;
  }

  if (continuityPayload.status === "fulfilled") {
    continuity.value = continuityPayload.value;
  } else {
    error.value = "Tool sync service is unavailable. Check .xtctx/tool-config/shared.yaml.";
  }

  if (warningsPayload.status === "fulfilled") {
    warnings.value = warningsPayload.value;
  }

  loading.value = false;
});
</script>

<template>
  <section class="space-y-6">
    <header class="space-y-3">
      <p class="xt-eyebrow">Continuity posture</p>
      <h2 class="xt-title">Session readiness</h2>
      <p class="max-w-3xl text-base leading-relaxed text-muted">
        Use this view as an operator checklist: confirm posture, recover context, then write back outcomes.
      </p>
    </header>

    <div v-if="error" class="xt-alert-danger">{{ error }}</div>

    <section class="xt-card space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h3 class="xt-section-title text-xl">Readiness summary</h3>
        <RouterLink v-if="warningCount > 0" to="/tools" custom v-slot="{ navigate }">
          <button class="xt-btn-ghost" type="button" @click="navigate">Review tool warnings</button>
        </RouterLink>
      </div>

      <div class="xt-alert" :class="readinessClass">{{ readinessText }}</div>

      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <article class="xt-kpi">
          <p class="xt-kpi-value">{{ connectedSources }}</p>
          <p class="xt-kpi-label">Connected sources</p>
        </article>
        <article class="xt-kpi">
          <p class="xt-kpi-value">{{ indexedRecords }}</p>
          <p class="xt-kpi-label">Indexed records</p>
        </article>
        <article class="xt-kpi">
          <p class="xt-kpi-value">{{ inSyncTools }}</p>
          <p class="xt-kpi-label">In-sync tools</p>
        </article>
        <article class="xt-kpi">
          <p class="xt-kpi-value">{{ sessionsCount }}</p>
          <p class="xt-kpi-label">Recent sessions</p>
        </article>
      </div>

      <div class="space-y-2">
        <p class="xt-eyebrow">Tool sync strip</p>
        <p v-if="!continuity?.tools.length" class="text-sm text-muted">Tool sync status unavailable.</p>
        <div v-else class="flex flex-wrap gap-2">
          <span v-for="tool in continuity?.tools ?? []" :key="tool.tool" class="xt-chip-neutral">
            {{ tool.tool }}: {{ tool.state.replace(/_/g, " ") }}
          </span>
        </div>
      </div>
    </section>

    <div class="grid gap-4 xl:grid-cols-2">
      <section class="xt-card space-y-4">
        <h3 class="xt-section-title text-xl">Start this session</h3>
        <ol class="list-decimal space-y-2 pl-5 text-base leading-relaxed">
          <li>Search the active task or failure signature.</li>
          <li>Load project knowledge with <code>type: all</code>.</li>
          <li>Implement with recovered constraints in scope.</li>
        </ol>

        <div class="flex flex-wrap gap-2">
          <RouterLink to="/search" custom v-slot="{ navigate }">
            <button class="xt-btn" type="button" @click="navigate">Open search</button>
          </RouterLink>
          <RouterLink to="/knowledge" custom v-slot="{ navigate }">
            <button class="xt-btn-ghost" type="button" @click="navigate">Open knowledge</button>
          </RouterLink>
        </div>
      </section>

      <section class="xt-card space-y-4">
        <h3 class="xt-section-title text-xl">Writeback checklist</h3>
        <ul class="list-disc space-y-2 pl-5 text-base leading-relaxed text-muted">
          <li>Persist a decision for design or implementation choices.</li>
          <li>Capture fix patterns using error solutions when failures occur.</li>
          <li>Store reusable Q&A as FAQ records for future sessions.</li>
        </ul>

        <div class="flex flex-wrap gap-2">
          <span class="xt-chip-ok">xtctx_save_decision</span>
          <span class="xt-chip-neutral">xtctx_save_error_solution</span>
          <span class="xt-chip-neutral">xtctx_save_faq</span>
        </div>
      </section>
    </div>

    <section v-if="!loading && (warnings?.warnings.length ?? 0) > 0" class="xt-card space-y-4">
      <h3 class="xt-section-title text-xl">Drift and warnings</h3>
      <div class="flex flex-wrap gap-2">
        <RouterLink to="/tools" custom v-slot="{ navigate }">
          <button class="xt-btn-ghost" type="button" @click="navigate">Open tools page</button>
        </RouterLink>
      </div>
      <ul class="list-disc space-y-2 pl-5 text-base leading-relaxed">
        <li v-for="entry in warnings?.warnings ?? []" :key="`${entry.tool}-${entry.warning}`">
          <strong>{{ entry.tool }}</strong>: {{ entry.warning }}
        </li>
      </ul>
    </section>
  </section>
</template>
