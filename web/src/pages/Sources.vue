<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { apiGet } from "../composables/useApi";
import type { SourceStatusResponse, SourcesResponse } from "../types";

const loading = ref(true);
const error = ref("");
const status = ref<SourceStatusResponse | null>(null);
const sources = ref<SourcesResponse | null>(null);

const detectedCount = computed(
  () => status.value?.scrapers.filter((scraper) => scraper.enabled && scraper.detected).length ?? 0,
);

const enabledCount = computed(
  () => status.value?.scrapers.filter((scraper) => scraper.enabled).length ?? 0,
);

const missingSources = computed(() =>
  status.value?.scrapers.filter((scraper) => scraper.enabled && !scraper.detected) ?? [],
);

onMounted(async () => {
  loading.value = true;

  const [statusPayload, sourcesPayload] = await Promise.allSettled([
    apiGet<SourceStatusResponse>("/api/sources/status"),
    apiGet<SourcesResponse>("/api/sources"),
  ]);

  if (statusPayload.status === "fulfilled") {
    status.value = statusPayload.value;
  } else {
    error.value = "Unable to load scraper health.";
  }

  if (sourcesPayload.status === "fulfilled") {
    sources.value = sourcesPayload.value;
  } else if (!error.value) {
    error.value = "Unable to load source inventory.";
  }

  loading.value = false;
});

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function stateClass(value: boolean): string {
  return value ? "xt-chip-ok" : "xt-chip-neutral";
}
</script>

<template>
  <section class="space-y-6">
    <header class="space-y-3">
      <p class="xt-eyebrow">Ingestion coverage</p>
      <h2 class="xt-title">Sources and ingestion</h2>
      <p class="max-w-3xl text-base leading-relaxed text-muted">
        Confirm that local assistant histories are detectable and producing session records for recall.
      </p>
    </header>

    <div v-if="error" class="xt-alert-danger">{{ error }}</div>

    <section class="xt-card space-y-4">
      <h3 class="xt-section-title text-xl">Ingestion posture</h3>
      <p
        class="xt-alert"
        :class="missingSources.length > 0 ? 'xt-alert-warn' : 'xt-alert-ok'"
      >
        <template v-if="missingSources.length > 0">
          {{ missingSources.length }} enabled source{{ missingSources.length > 1 ? "s are" : " is" }} not detected.
          Check scraper paths before relying on continuity recall.
        </template>
        <template v-else>
          All enabled scraper sources are detected and ready for ingestion.
        </template>
      </p>

      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <article class="xt-kpi">
          <p class="xt-kpi-value">{{ enabledCount }}</p>
          <p class="xt-kpi-label">Enabled scrapers</p>
        </article>
        <article class="xt-kpi">
          <p class="xt-kpi-value">{{ detectedCount }}</p>
          <p class="xt-kpi-label">Detected sources</p>
        </article>
        <article class="xt-kpi">
          <p class="xt-kpi-value">{{ status?.knowledgeRecords ?? 0 }}</p>
          <p class="xt-kpi-label">Indexed records</p>
        </article>
        <article class="xt-kpi">
          <p class="xt-kpi-value">{{ sources?.sessions.length ?? 0 }}</p>
          <p class="xt-kpi-label">Recent sessions</p>
        </article>
      </div>

      <div v-if="missingSources.length > 0" class="space-y-2">
        <p class="xt-eyebrow">Missing detections</p>
        <ul class="list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted">
          <li v-for="scraper in missingSources" :key="`${scraper.tool}-${scraper.path}`">
            <strong>{{ scraper.tool }}</strong>: <code>{{ scraper.path }}</code>
          </li>
        </ul>
      </div>
    </section>

    <section class="xt-card overflow-x-auto">
      <h3 class="xt-section-title mb-4 text-xl">Scraper health matrix</h3>
      <table class="xt-table min-w-[680px]">
        <thead>
          <tr>
            <th>Tool</th>
            <th>Enabled</th>
            <th>Detected</th>
            <th>Path</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="scraper in status?.scrapers ?? []" :key="`${scraper.tool}-${scraper.path}`">
            <td>{{ scraper.tool }}</td>
            <td><span :class="stateClass(scraper.enabled)">{{ yesNo(scraper.enabled) }}</span></td>
            <td><span :class="stateClass(scraper.detected)">{{ yesNo(scraper.detected) }}</span></td>
            <td><code class="text-xs">{{ scraper.path }}</code></td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="xt-card overflow-x-auto">
      <h3 class="xt-section-title mb-4 text-xl">Recent ingested sessions</h3>
      <table class="xt-table min-w-[680px]">
        <thead>
          <tr>
            <th>Session</th>
            <th>Tool</th>
            <th>Started</th>
            <th>Messages</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="session in sources?.sessions ?? []" :key="session.session_ref">
            <td><code class="text-xs">{{ session.session_ref }}</code></td>
            <td>{{ session.tool }}</td>
            <td>{{ new Date(session.started_at).toLocaleString() }}</td>
            <td>{{ session.message_count ?? 0 }}</td>
          </tr>
        </tbody>
      </table>

      <p v-if="!loading && (sources?.sessions.length ?? 0) === 0" class="mt-3 text-sm text-muted">
        No ingested sessions yet. Run <code>xtctx ingest --full</code> after configuring scraper paths.
      </p>
    </section>
  </section>
</template>
