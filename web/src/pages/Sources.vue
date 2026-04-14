<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { apiGet, apiPut } from "../composables/useApi";
import type {
  ScraperConfigUpdateResponse,
  SourcesConfigResponse,
  SourcesResponse,
} from "../types";

interface ScraperEditorState {
  enabled: boolean;
  customStorePath: string;
}

const loading = ref(true);
const error = ref("");
const flash = ref("");
const config = ref<SourcesConfigResponse | null>(null);
const sources = ref<SourcesResponse | null>(null);
const editor = reactive<Record<string, ScraperEditorState>>({});
const saving = reactive<Record<string, boolean>>({});

const enabledCount = computed(
  () => config.value?.scrapers.filter((scraper) => scraper.enabled).length ?? 0,
);
const detectedCount = computed(
  () => config.value?.scrapers.filter((scraper) => scraper.enabled && scraper.detected).length ?? 0,
);
const missingCount = computed(() => Math.max(enabledCount.value - detectedCount.value, 0));

onMounted(async () => {
  await refresh();
});

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = "";
  flash.value = "";

  const [configPayload, sourcesPayload] = await Promise.allSettled([
    apiGet<SourcesConfigResponse>("/api/sources/config"),
    apiGet<SourcesResponse>("/api/sources"),
  ]);

  if (configPayload.status === "fulfilled") {
    config.value = configPayload.value;
    hydrateEditor(configPayload.value);
  } else {
    error.value = configPayload.reason instanceof Error ? configPayload.reason.message : String(configPayload.reason);
  }

  if (sourcesPayload.status === "fulfilled") {
    sources.value = sourcesPayload.value;
  } else if (!error.value) {
    error.value = sourcesPayload.reason instanceof Error ? sourcesPayload.reason.message : String(sourcesPayload.reason);
  }

  loading.value = false;
}

function hydrateEditor(nextConfig: SourcesConfigResponse): void {
  for (const scraper of nextConfig.scrapers) {
    const key = scraper.tool;
    const existing = editor[key];

    if (!existing) {
      editor[key] = {
        enabled: scraper.enabled,
        customStorePath: "",
      };
      continue;
    }

    existing.enabled = scraper.enabled;
  }
}

function editorState(tool: string): ScraperEditorState {
  const current = editor[tool];
  if (current) return current;

  const created: ScraperEditorState = {
    enabled: true,
    customStorePath: "",
  };
  editor[tool] = created;
  return created;
}

function stateChipClass(detected: boolean): string {
  return detected ? "xt-chip-ok" : "xt-chip-warn";
}

async function saveScraper(tool: string): Promise<void> {
  const state = editor[tool];
  if (!state) return;

  saving[tool] = true;
  error.value = "";
  flash.value = "";

  try {
    const payload: { enabled: boolean; customStorePath?: string | null } = {
      enabled: state.enabled,
    };

    const custom = state.customStorePath.trim();
    if (custom.length > 0) {
      payload.customStorePath = custom;
    }

    const response = await apiPut<ScraperConfigUpdateResponse>(`/api/sources/scrapers/${encodeURIComponent(tool)}`, payload);
    if (config.value) {
      config.value.scrapers = response.scrapers;
    }
    flash.value = `${tool} source configuration saved.`;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving[tool] = false;
  }
}

async function resetCustomPath(tool: string): Promise<void> {
  saving[tool] = true;
  error.value = "";
  flash.value = "";

  try {
    const response = await apiPut<ScraperConfigUpdateResponse>(
      `/api/sources/scrapers/${encodeURIComponent(tool)}`,
      {
        customStorePath: null,
      },
    );

    if (editor[tool]) {
      editor[tool].customStorePath = "";
      editor[tool].enabled = response.scraper?.enabled ?? editor[tool].enabled;
    }
    if (config.value) {
      config.value.scrapers = response.scrapers;
    }
    flash.value = `${tool} now uses the default source path.`;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving[tool] = false;
  }
}
</script>

<template>
  <section class="space-y-6">
    <header class="space-y-3">
      <p class="xt-eyebrow">Source management</p>
      <h2 class="xt-title">Ingestion sources</h2>
      <p class="max-w-3xl text-base leading-relaxed text-muted">
        Configure source paths per tool, validate detection, and monitor session ingestion coverage.
      </p>
    </header>

    <div v-if="error" class="xt-alert-danger">{{ error }}</div>
    <div v-if="flash" class="xt-alert-ok">{{ flash }}</div>

    <section class="xt-card space-y-4">
      <h3 class="xt-section-title text-xl">Coverage posture</h3>
      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <article class="xt-kpi">
          <p class="xt-kpi-value">{{ enabledCount }}</p>
          <p class="xt-kpi-label">Enabled sources</p>
        </article>
        <article class="xt-kpi">
          <p class="xt-kpi-value">{{ detectedCount }}</p>
          <p class="xt-kpi-label">Detected sources</p>
        </article>
        <article class="xt-kpi">
          <p class="xt-kpi-value">{{ missingCount }}</p>
          <p class="xt-kpi-label">Missing detections</p>
        </article>
        <article class="xt-kpi">
          <p class="xt-kpi-value">{{ sources?.sessions.length ?? 0 }}</p>
          <p class="xt-kpi-label">Recent sessions</p>
        </article>
      </div>

      <div class="grid gap-2 text-sm text-muted md:grid-cols-3">
        <p>
          <span class="xt-eyebrow">Poll interval</span><br />
          {{ config?.pollIntervalMs ?? 0 }} ms
        </p>
        <p>
          <span class="xt-eyebrow">Watch paths</span><br />
          {{ config?.watchPaths.join(", ") || "n/a" }}
        </p>
        <p>
          <span class="xt-eyebrow">Exclude patterns</span><br />
          {{ config?.excludePatterns.join(", ") || "n/a" }}
        </p>
      </div>
    </section>

    <section class="xt-card space-y-4">
      <h3 class="xt-section-title text-xl">Per-tool source config</h3>
      <div v-if="loading" class="grid gap-4 lg:grid-cols-2">
        <article v-for="idx in 4" :key="idx" class="xt-card h-48 animate-pulse" />
      </div>

      <div v-else class="grid gap-4 lg:grid-cols-2">
        <article
          v-for="scraper in config?.scrapers ?? []"
          :key="scraper.tool"
          class="rounded-lg border bg-surface p-4 space-y-3"
        >
          <header class="flex items-center justify-between gap-3">
            <h4 class="text-lg font-semibold">{{ scraper.tool }}</h4>
            <span :class="stateChipClass(scraper.detected)">
              {{ scraper.detected ? "detected" : "not detected" }}
            </span>
          </header>

          <label class="flex items-center gap-2 text-sm">
            <input v-model="editorState(scraper.tool).enabled" type="checkbox" class="h-4 w-4" />
            Enable ingestion for this source
          </label>

          <div class="space-y-2">
            <p class="xt-eyebrow">Current path</p>
            <code class="block text-xs">{{ scraper.path }}</code>
          </div>

          <div class="space-y-2">
            <p class="xt-eyebrow">Custom store path override</p>
            <input
              v-model="editorState(scraper.tool).customStorePath"
              class="xt-input"
              placeholder="Leave empty to keep current/default path"
            />
          </div>

          <div class="flex flex-wrap gap-2">
            <button class="xt-btn" type="button" :disabled="saving[scraper.tool]" @click="saveScraper(scraper.tool)">
              {{ saving[scraper.tool] ? "Saving..." : "Save source config" }}
            </button>
            <button class="xt-btn-ghost" type="button" :disabled="saving[scraper.tool]" @click="resetCustomPath(scraper.tool)">
              Use default path
            </button>
          </div>
        </article>
      </div>
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
        No sessions ingested yet.
      </p>
    </section>
  </section>
</template>
