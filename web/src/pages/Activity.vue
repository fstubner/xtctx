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

  if (sourcesPayload.status === "fulfilled") sources.value = sourcesPayload.value;
  if (continuityPayload.status === "fulfilled") continuity.value = continuityPayload.value;
  if (warningsPayload.status === "fulfilled") warnings.value = warningsPayload.value;

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
    flash.value = `Sync complete — ${result.updated} updated, ${result.created} created, ${result.unchanged} unchanged.`;
    await refresh();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    syncing.value = false;
  }
}
</script>

<template>
  <section>
    <!-- Page header -->
    <div class="mb-8 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 class="xt-title">Activity</h1>
        <p class="mt-1 text-sm text-muted">Ingestion sessions and sync operation history.</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <button class="xt-btn" type="button" :disabled="syncing" @click="runSyncAll">
          {{ syncing ? "Syncing…" : "Run sync" }}
        </button>
        <button class="xt-btn-ghost" type="button" @click="refresh">Refresh</button>
      </div>
    </div>

    <div v-if="error" class="xt-alert-danger mb-6">{{ error }}</div>
    <div v-if="flash" class="xt-alert-ok mb-6">{{ flash }}</div>

    <!-- Sync KPI grid -->
    <div class="mb-8 grid grid-cols-2 gap-x-6 gap-y-5 border-b pb-8 md:grid-cols-4">
      <div>
        <p class="xt-kpi-value">{{ toolsByState.inSync }}</p>
        <p class="xt-kpi-label">Tools in sync</p>
      </div>
      <div>
        <p class="xt-kpi-value" :class="toolsByState.drifted > 0 ? 'text-warn' : ''">
          {{ toolsByState.drifted }}
        </p>
        <p class="xt-kpi-label">Drifted tools</p>
      </div>
      <div>
        <p class="xt-kpi-value" :class="toolsByState.missing > 0 ? 'text-warn' : ''">
          {{ toolsByState.missing }}
        </p>
        <p class="xt-kpi-label">Missing targets</p>
      </div>
      <div>
        <p class="xt-kpi-value" :class="(warnings?.count ?? 0) > 0 ? 'text-warn' : ''">
          {{ warnings?.count ?? 0 }}
        </p>
        <p class="xt-kpi-label">Warnings</p>
      </div>
    </div>

    <!-- Last sync result -->
    <div v-if="lastSync" class="mb-8 border-b pb-8">
      <h2 class="xt-section-title mb-3">Last sync result</h2>
      <p class="text-sm text-muted">
        {{ lastSync.updated }} updated · {{ lastSync.created }} created · {{ lastSync.unchanged }} unchanged
      </p>
    </div>

    <!-- Warning queue -->
    <div v-if="(warnings?.warnings.length ?? 0) > 0" class="mb-8 border-b pb-8">
      <h2 class="xt-section-title mb-4">Warnings</h2>
      <div
        v-for="(entry, i) in warnings?.warnings ?? []"
        :key="`${entry.tool}-${entry.warning}`"
        class="py-3"
        :class="i > 0 ? 'border-t' : ''"
      >
        <p class="text-sm font-medium">{{ entry.tool }}</p>
        <p class="mt-0.5 text-sm text-muted">{{ entry.warning }}</p>
      </div>
    </div>

    <!-- Sessions table -->
    <div>
      <h2 class="xt-section-title mb-4">Ingested sessions</h2>

      <p v-if="loading" class="text-sm text-muted">Loading…</p>
      <p v-else-if="(sources?.sessions.length ?? 0) === 0" class="text-sm text-muted">
        No sessions indexed yet.
      </p>
      <div v-else class="overflow-x-auto">
        <table class="xt-table min-w-[640px]">
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
      </div>
    </div>
  </section>
</template>
