<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { apiGet, apiPost } from "../composables/useApi";
import type {
  ContinuitySyncResult,
  ContinuityToolsStatusResponse,
  ContinuityWarningsResponse,
  SourcesResponse,
} from "../types";

const loading = ref(true);
const error = ref("");
const flash = ref("");
const syncing = ref(false);
const sources = ref<SourcesResponse | null>(null);
const continuity = ref<ContinuityToolsStatusResponse | null>(null);
const warnings = ref<ContinuityWarningsResponse | null>(null);
const lastSync = ref<ContinuitySyncResult | null>(null);

const toolsByState = computed(() => {
  const entries = continuity.value?.tools ?? [];
  return {
    inSync: entries.filter((tool) => tool.state === "in_sync" && tool.enabled).length,
    drifted: entries.filter((tool) => tool.state === "drifted" && tool.enabled).length,
    missing: entries.filter((tool) => tool.state === "missing_target" && tool.enabled).length,
  };
});

onMounted(async () => {
  await refresh();
});

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = "";

  const [sourcesPayload, continuityPayload, warningsPayload] = await Promise.allSettled([
    apiGet<SourcesResponse>("/api/sources"),
    apiGet<ContinuityToolsStatusResponse>("/api/continuity/tools-status"),
    apiGet<ContinuityWarningsResponse>("/api/continuity/warnings"),
  ]);

  if (sourcesPayload.status === "fulfilled") {
    sources.value = sourcesPayload.value;
  }
  if (continuityPayload.status === "fulfilled") {
    continuity.value = continuityPayload.value;
  }
  if (warningsPayload.status === "fulfilled") {
    warnings.value = warningsPayload.value;
  }

  if (
    sourcesPayload.status === "rejected"
    || continuityPayload.status === "rejected"
    || warningsPayload.status === "rejected"
  ) {
    const firstError = sourcesPayload.status === "rejected"
      ? sourcesPayload.reason
      : continuityPayload.status === "rejected"
        ? continuityPayload.reason
        : warningsPayload.status === "rejected"
          ? warningsPayload.reason
          : "Unknown error";

    error.value = firstError instanceof Error ? firstError.message : String(firstError);
  }

  loading.value = false;
}

async function runSyncAll(): Promise<void> {
  syncing.value = true;
  error.value = "";
  flash.value = "";

  try {
    const result = await apiPost<ContinuitySyncResult>("/api/continuity/sync", {});
    lastSync.value = result;
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
      <p class="xt-eyebrow">Runtime activity</p>
      <h2 class="xt-title">Automation activity</h2>
      <p class="max-w-3xl text-base leading-relaxed text-muted">
        Observe ingestion and sync operations, then trigger manual reconciliation when required.
      </p>
    </header>

    <div v-if="error" class="xt-alert-danger">{{ error }}</div>
    <div v-if="flash" class="xt-alert-ok">{{ flash }}</div>

    <section class="xt-card space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h3 class="xt-section-title text-xl">Sync operations</h3>
        <button class="xt-btn" type="button" :disabled="syncing" @click="runSyncAll">
          {{ syncing ? "Syncing..." : "Run sync all tools" }}
        </button>
      </div>

      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <article class="xt-kpi">
          <p class="xt-kpi-value">{{ toolsByState.inSync }}</p>
          <p class="xt-kpi-label">Tools in sync</p>
        </article>
        <article class="xt-kpi">
          <p class="xt-kpi-value">{{ toolsByState.drifted }}</p>
          <p class="xt-kpi-label">Drifted tools</p>
        </article>
        <article class="xt-kpi">
          <p class="xt-kpi-value">{{ toolsByState.missing }}</p>
          <p class="xt-kpi-label">Missing targets</p>
        </article>
        <article class="xt-kpi">
          <p class="xt-kpi-value">{{ warnings?.count ?? 0 }}</p>
          <p class="xt-kpi-label">Warnings</p>
        </article>
      </div>

      <p v-if="loading" class="text-sm text-muted">Loading activity snapshot...</p>
      <p v-else-if="!lastSync" class="text-sm text-muted">
        No manual sync operation has been run in this UI session.
      </p>
      <div v-else class="rounded-lg border bg-surface-2 p-3 text-sm text-muted">
        Last sync result: {{ lastSync.updated }} updated, {{ lastSync.created }} created,
        {{ lastSync.unchanged }} unchanged.
      </div>
    </section>

    <section class="xt-card space-y-4">
      <h3 class="xt-section-title text-xl">Warning queue</h3>
      <ul v-if="(warnings?.warnings.length ?? 0) > 0" class="list-disc space-y-2 pl-5 text-sm leading-relaxed">
        <li v-for="entry in warnings?.warnings ?? []" :key="`${entry.tool}-${entry.warning}`">
          <strong>{{ entry.tool }}</strong>: {{ entry.warning }}
        </li>
      </ul>
      <p v-else class="text-sm text-muted">No active continuity warnings.</p>
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
        No session activity has been ingested yet.
      </p>
    </section>

    <div class="flex flex-wrap gap-2">
      <button class="xt-btn-ghost" type="button" @click="refresh">Refresh activity</button>
      <a class="xt-btn-ghost" href="/api/sources" target="_blank" rel="noreferrer">Open sources API</a>
      <a class="xt-btn-ghost" href="/api/continuity/tools-status" target="_blank" rel="noreferrer">
        Open tools status API
      </a>
    </div>
  </section>
</template>
