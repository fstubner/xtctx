<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { apiGet, apiPost } from "../composables/useApi";
import type {
  ContinuitySyncResult,
  ContinuityToolsStatusResponse,
  ContinuityWarningsResponse,
  SourceStatusResponse,
  SourcesConfigResponse,
  SourcesResponse,
} from "../types";

const loading = ref(true);
const error = ref("");
const flash = ref("");
const syncing = ref(false);
const status = ref<SourceStatusResponse | null>(null);
const continuity = ref<ContinuityToolsStatusResponse | null>(null);
const warnings = ref<ContinuityWarningsResponse | null>(null);
const sessions = ref<SourcesResponse["sessions"]>([]);
const config = ref<SourcesConfigResponse | null>(null);

const enabledSources = computed(() => status.value?.scrapers.filter((scraper) => scraper.enabled).length ?? 0);
const detectedSources = computed(() => status.value?.scrapers.filter((scraper) => scraper.enabled && scraper.detected).length ?? 0);
const enabledTools = computed(() => continuity.value?.tools.filter((tool) => tool.enabled).length ?? 0);
const inSyncTools = computed(() => continuity.value?.tools.filter((tool) => tool.enabled && tool.state === "in_sync").length ?? 0);
const driftedTools = computed(() => enabledTools.value - inSyncTools.value);
const warningCount = computed(() => warnings.value?.count ?? 0);
const indexedRecords = computed(() => status.value?.knowledgeRecords ?? 0);
const unreachableSources = computed(() => Math.max(enabledSources.value - detectedSources.value, 0));
const activeWatchPath = computed(() => config.value?.watchPaths[0] ?? "Not configured");
const pollIntervalSeconds = computed(() => {
  const intervalMs = config.value?.pollIntervalMs ?? 0;
  return intervalMs > 0 ? Math.round(intervalMs / 1000) : null;
});

const dashboardStateLabel = computed(() => {
  if (loading.value) return "loading";
  if (error.value) return "degraded";
  if (unreachableSources.value > 0 || driftedTools.value > 0) return "attention needed";
  if (indexedRecords.value === 0) return "warming up";
  return "healthy";
});

const dashboardStateClass = computed(() => {
  if (loading.value) return "xt-chip-neutral";
  if (error.value) return "xt-chip-danger";
  if (unreachableSources.value > 0 || driftedTools.value > 0) return "xt-chip-warn";
  if (indexedRecords.value === 0) return "xt-chip-neutral";
  return "xt-chip-ok";
});

const memoryStateLabel = computed(() => {
  if (indexedRecords.value > 0) return "indexed";
  if ((sessions.value?.length ?? 0) > 0) return "capturing";
  return "empty";
});

const exceptions = computed(() => {
  const items: Array<{ title: string; detail: string; action: string; route: string }> = [];

  if (enabledSources.value === 0) {
    items.push({
      title: "No conversation sources enabled",
      detail: "xtctx is running, but no source paths are currently enabled for ingestion.",
      action: "Configure sources",
      route: "/tools",
    });
  } else if (unreachableSources.value > 0) {
    items.push({
      title: `${unreachableSources.value} source path${unreachableSources.value > 1 ? "s are" : " is"} unreachable`,
      detail: `${detectedSources.value} of ${enabledSources.value} enabled source paths can currently be read.`,
      action: "Review source settings",
      route: "/tools",
    });
  }

  if (driftedTools.value > 0) {
    items.push({
      title: `${driftedTools.value} tool target${driftedTools.value > 1 ? "s need" : " needs"} reconciliation`,
      detail: "Managed continuity blocks are missing or drifted from the effective policy.",
      action: "Open tool sync",
      route: "/tools",
    });
  }

  if (indexedRecords.value === 0) {
    items.push({
      title: "Project memory is empty",
      detail: "Conversation histories may be present, but no searchable continuity records have been written yet.",
      action: "Inspect memory",
      route: "/memory",
    });
  }

  if ((sessions.value?.length ?? 0) === 0) {
    items.push({
      title: "No recent session activity",
      detail: "The ingestion feed has not recorded recent assistant sessions for this project yet.",
      action: "View activity",
      route: "/activity",
    });
  }

  return items;
});

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

onMounted(async () => {
  await refresh();
});

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = "";
  flash.value = "";

  const [statusRes, continuityRes, warningsRes, sourcesRes, configRes] = await Promise.allSettled([
    apiGet<SourceStatusResponse>("/api/sources/status"),
    apiGet<ContinuityToolsStatusResponse>("/api/continuity/tools-status"),
    apiGet<ContinuityWarningsResponse>("/api/continuity/warnings"),
    apiGet<SourcesResponse>("/api/sources"),
    apiGet<SourcesConfigResponse>("/api/sources/config"),
  ]);

  if (statusRes.status === "fulfilled") status.value = statusRes.value;
  if (continuityRes.status === "fulfilled") continuity.value = continuityRes.value;
  if (warningsRes.status === "fulfilled") warnings.value = warningsRes.value;
  if (sourcesRes.status === "fulfilled") sessions.value = sourcesRes.value.sessions ?? [];
  if (configRes.status === "fulfilled") config.value = configRes.value;

  if (
    statusRes.status === "rejected"
    || continuityRes.status === "rejected"
    || warningsRes.status === "rejected"
    || sourcesRes.status === "rejected"
    || configRes.status === "rejected"
  ) {
    const firstError = statusRes.status === "rejected"
      ? statusRes.reason
      : continuityRes.status === "rejected"
        ? continuityRes.reason
        : warningsRes.status === "rejected"
          ? warningsRes.reason
          : sourcesRes.status === "rejected"
            ? sourcesRes.reason
            : configRes.status === "rejected"
              ? configRes.reason
              : "Unknown error";
    error.value = firstError instanceof Error ? firstError.message : String(firstError);
  }

  loading.value = false;
}

async function syncAllTools(): Promise<void> {
  syncing.value = true;
  error.value = "";
  flash.value = "";

  try {
    const result = await apiPost<ContinuitySyncResult>("/api/continuity/sync", {});
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
  <section class="space-y-8">
    <header class="flex flex-wrap items-start justify-between gap-4 border-b pb-6">
      <div class="space-y-2">
        <p class="xt-eyebrow">Overview</p>
        <h1 class="xt-title">Dashboard</h1>
        <p class="max-w-3xl text-sm leading-relaxed text-muted">
          Monitor ingestion health, sync drift, and memory coverage for this project runtime.
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <span :class="dashboardStateClass">{{ dashboardStateLabel }}</span>
        <button class="xt-btn" type="button" :disabled="syncing" @click="syncAllTools">
          {{ syncing ? "Syncing…" : "Run sync" }}
        </button>
        <button class="xt-btn-ghost" type="button" @click="refresh">Refresh</button>
      </div>
    </header>

    <div v-if="error" class="xt-alert-danger">{{ error }}</div>
    <div v-if="flash" class="xt-alert-ok">{{ flash }}</div>

    <div class="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_340px]">
      <div class="space-y-6">
        <section class="xt-card space-y-5">
          <div class="flex items-center justify-between gap-3">
            <div>
              <p class="xt-eyebrow mb-1">Control plane</p>
              <h2 class="xt-section-title">Automation health</h2>
            </div>
            <span :class="dashboardStateClass">{{ dashboardStateLabel }}</span>
          </div>

          <div class="grid gap-4 lg:grid-cols-3">
            <article class="rounded-xl border bg-surface p-4">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <p class="xt-eyebrow mb-2">Sources</p>
                  <h3 class="font-semibold">Ingestion coverage</h3>
                </div>
                <span :class="unreachableSources > 0 ? 'xt-chip-warn' : 'xt-chip-ok'">
                  {{ unreachableSources > 0 ? "needs review" : "healthy" }}
                </span>
              </div>
              <p class="mt-4 text-3xl font-semibold tracking-tight">
                {{ detectedSources }}<span class="text-lg text-muted">/{{ enabledSources }}</span>
              </p>
              <p class="mt-2 text-sm leading-relaxed text-muted">
                Enabled source paths currently reachable by the ingestion daemon.
              </p>
              <RouterLink to="/tools" custom v-slot="{ navigate }">
                <button class="xt-btn-ghost mt-4 text-xs" type="button" @click="navigate">Open source config</button>
              </RouterLink>
            </article>

            <article class="rounded-xl border bg-surface p-4">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <p class="xt-eyebrow mb-2">Continuity</p>
                  <h3 class="font-semibold">Tool sync</h3>
                </div>
                <span :class="driftedTools > 0 ? 'xt-chip-warn' : 'xt-chip-ok'">
                  {{ driftedTools > 0 ? "attention" : "aligned" }}
                </span>
              </div>
              <p class="mt-4 text-3xl font-semibold tracking-tight">
                {{ inSyncTools }}<span class="text-lg text-muted">/{{ enabledTools }}</span>
              </p>
              <p class="mt-2 text-sm leading-relaxed text-muted">
                Managed tool targets currently aligned with the effective continuity policy.
              </p>
              <RouterLink to="/tools" custom v-slot="{ navigate }">
                <button class="xt-btn-ghost mt-4 text-xs" type="button" @click="navigate">Review tool targets</button>
              </RouterLink>
            </article>

            <article class="rounded-xl border bg-surface p-4">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <p class="xt-eyebrow mb-2">Memory</p>
                  <h3 class="font-semibold">Indexed knowledge</h3>
                </div>
                <span :class="indexedRecords > 0 ? 'xt-chip-ok' : 'xt-chip-neutral'">
                  {{ memoryStateLabel }}
                </span>
              </div>
              <p class="mt-4 text-3xl font-semibold tracking-tight">{{ indexedRecords }}</p>
              <p class="mt-2 text-sm leading-relaxed text-muted">
                Searchable project records available to recall and writeback workflows.
              </p>
              <RouterLink to="/memory" custom v-slot="{ navigate }">
                <button class="xt-btn-ghost mt-4 text-xs" type="button" @click="navigate">Inspect memory</button>
              </RouterLink>
            </article>
          </div>
        </section>

        <section class="xt-card space-y-4">
          <div class="flex items-center justify-between gap-3">
            <div>
              <p class="xt-eyebrow mb-1">Exceptions</p>
              <h2 class="xt-section-title">Action queue</h2>
            </div>
            <span :class="exceptions.length > 0 ? 'xt-chip-warn' : 'xt-chip-ok'">
              {{ exceptions.length > 0 ? `${exceptions.length} item${exceptions.length > 1 ? "s" : ""}` : "clear" }}
            </span>
          </div>

          <div v-if="loading" class="text-sm text-muted">Loading runtime posture…</div>
          <div v-else-if="exceptions.length === 0" class="rounded-xl border bg-surface px-4 py-3 text-sm text-muted">
            No active blockers. Sources are reachable, tool sync is aligned, and project memory is available.
          </div>
          <div v-else class="space-y-0">
            <div
              v-for="(item, index) in exceptions"
              :key="item.title"
              class="flex flex-wrap items-start justify-between gap-4 py-4"
              :class="index > 0 ? 'border-t' : ''"
            >
              <div class="min-w-0 flex-1">
                <p class="font-medium">{{ item.title }}</p>
                <p class="mt-1 text-sm leading-relaxed text-muted">{{ item.detail }}</p>
              </div>
              <RouterLink :to="item.route" custom v-slot="{ navigate }">
                <button class="xt-btn-ghost text-xs" type="button" @click="navigate">{{ item.action }}</button>
              </RouterLink>
            </div>
          </div>
        </section>

        <section class="xt-card space-y-4">
          <div class="flex items-center justify-between gap-3">
            <div>
              <p class="xt-eyebrow mb-1">Activity</p>
              <h2 class="xt-section-title">Recent sessions</h2>
            </div>
            <RouterLink to="/activity" custom v-slot="{ navigate }">
              <button class="xt-btn-ghost text-xs" type="button" @click="navigate">Open activity log</button>
            </RouterLink>
          </div>

          <p v-if="sessions.length === 0" class="text-sm text-muted">
            No sessions have been ingested yet for this project.
          </p>

          <div v-else class="overflow-hidden rounded-xl border bg-surface">
            <div
              v-for="session in sessions.slice(0, 6)"
              :key="session.session_ref"
              class="grid gap-2 px-4 py-3 text-sm md:grid-cols-[110px_minmax(0,1fr)_90px_72px]"
              :class="'border-t first:border-t-0'"
            >
              <span class="font-mono text-xs uppercase tracking-[0.08em] text-muted">{{ session.tool }}</span>
              <span class="truncate">{{ session.session_ref }}</span>
              <span class="text-muted">{{ relativeTime(session.started_at) }}</span>
              <span class="text-right text-muted">{{ session.message_count ?? 0 }} msg</span>
            </div>
          </div>
        </section>
      </div>

      <aside class="space-y-6">
        <section class="xt-card space-y-4">
          <div>
            <p class="xt-eyebrow mb-1">Runtime</p>
            <h2 class="xt-section-title">Configuration</h2>
          </div>

          <dl class="space-y-4 text-sm">
            <div>
              <dt class="xt-eyebrow mb-1">Watch path</dt>
              <dd class="break-all font-mono text-xs">{{ activeWatchPath }}</dd>
            </div>
            <div>
              <dt class="xt-eyebrow mb-1">Poll interval</dt>
              <dd>{{ pollIntervalSeconds ? `${pollIntervalSeconds}s` : "Not configured" }}</dd>
            </div>
            <div>
              <dt class="xt-eyebrow mb-1">Warnings</dt>
              <dd>{{ warningCount }}</dd>
            </div>
            <div>
              <dt class="xt-eyebrow mb-1">Last known state</dt>
              <dd>{{ dashboardStateLabel }}</dd>
            </div>
          </dl>
        </section>

        <section class="xt-card space-y-4">
          <div>
            <p class="xt-eyebrow mb-1">Actions</p>
            <h2 class="xt-section-title">Manage runtime</h2>
          </div>

          <div class="grid gap-2">
            <RouterLink to="/tools" custom v-slot="{ navigate }">
              <button class="xt-btn w-full justify-between" type="button" @click="navigate">
                Tool sync
                <span aria-hidden="true">→</span>
              </button>
            </RouterLink>

            <RouterLink to="/memory" custom v-slot="{ navigate }">
              <button class="xt-btn-ghost w-full justify-between" type="button" @click="navigate">
                Inspect memory
                <span aria-hidden="true">→</span>
              </button>
            </RouterLink>

            <RouterLink to="/activity" custom v-slot="{ navigate }">
              <button class="xt-btn-ghost w-full justify-between" type="button" @click="navigate">
                Review activity
                <span aria-hidden="true">→</span>
              </button>
            </RouterLink>
          </div>
        </section>
      </aside>
    </div>
  </section>
</template>
