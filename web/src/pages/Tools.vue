<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { apiGet, apiPost, apiPut } from "../composables/useApi";
import type {
  ContinuityCategory,
  ContinuityScope,
  ContinuityToolsStatusResponse,
  EffectivePolicyResponse,
  ScraperConfigUpdateResponse,
  SourcesConfigResponse,
  SourcesResponse,
  ToolContinuityStatus,
  ToolRenderPreviewResponse,
} from "../types";

// ── Tab ───────────────────────────────────────────────────
type ActiveTab = "tools" | "sources" | "config";
const tab = ref<ActiveTab>("tools");

// ── Shared state ──────────────────────────────────────────
const loading = ref(true);
const error = ref("");
const flash = ref("");

// ── Tools tab ─────────────────────────────────────────────
interface ToolEditorState {
  enabled: boolean;
  scope: ContinuityScope;
  categories: Record<ContinuityCategory, boolean>;
}

const syncingAll = ref(false);
const tools = ref<ToolContinuityStatus[]>([]);
const editor = reactive<Record<string, ToolEditorState>>({});
const pendingSave = reactive<Record<string, boolean>>({});
const pendingSync = reactive<Record<string, boolean>>({});
const previewVisible = ref(false);
const previewLoading = ref(false);
const previewMode = ref<"render" | "diff">("render");
const preview = ref<ToolRenderPreviewResponse | null>(null);

const scopeOptions: Array<{ label: string; value: ContinuityScope }> = [
  { label: "Project only", value: "project" },
  { label: "Global only", value: "global" },
  { label: "Hybrid", value: "hybrid" },
];

const categoryLabels: Record<ContinuityCategory, string> = {
  context_feed: "Context feed",
  skills: "Skills",
  commands: "Commands",
  agents: "Agents",
  mcp_servers: "MCP servers",
  slash_commands: "Slash commands",
  whitelist_policy: "Whitelist policy",
};

const orderedTools = computed(() => [...tools.value].sort((a, b) => toolOrder(a.tool) - toolOrder(b.tool)));

function toolOrder(tool: string): number {
  const order = ["claude", "claude-code", "cursor", "codex", "copilot", "gemini"];
  const i = order.indexOf(tool);
  return i === -1 ? 99 : i;
}

function stateLabel(state: ToolContinuityStatus["state"]): string {
  return state === "disabled_by_policy" ? "disabled by policy" : state.replace(/_/g, " ");
}

function stateChipClass(state: ToolContinuityStatus["state"]): string {
  if (state === "in_sync") return "xt-chip-ok";
  if (state === "missing_target") return "xt-chip-warn";
  if (state === "drifted") return "xt-chip-danger";
  return "xt-chip-neutral";
}

function ensureToolEditor(tool: string): ToolEditorState {
  if (!editor[tool]) {
    editor[tool] = {
      enabled: true,
      scope: "project",
      categories: {
        context_feed: true, skills: true, commands: true, agents: true,
        mcp_servers: true, slash_commands: true, whitelist_policy: true,
      },
    };
  }
  return editor[tool];
}

function onEnabledChange(tool: string, event: Event): void {
  const target = event.target;
  if (target instanceof HTMLInputElement) ensureToolEditor(tool).enabled = target.checked;
}

function onScopeChange(tool: string, event: Event): void {
  const target = event.target;
  if (target instanceof HTMLSelectElement) {
    const v = target.value;
    if (v === "project" || v === "global" || v === "hybrid") ensureToolEditor(tool).scope = v;
  }
}

function onCategoryChange(tool: string, key: ContinuityCategory, event: Event): void {
  const target = event.target;
  if (target instanceof HTMLInputElement) ensureToolEditor(tool).categories[key] = target.checked;
}

// ── Sources tab ───────────────────────────────────────────
interface ScraperEditorState {
  enabled: boolean;
  customStorePath: string;
}

const sourcesConfig = ref<SourcesConfigResponse | null>(null);
const sourcesData = ref<SourcesResponse | null>(null);
const scraperEditor = reactive<Record<string, ScraperEditorState>>({});
const scraperSaving = reactive<Record<string, boolean>>({});

const enabledCount = computed(() => sourcesConfig.value?.scrapers.filter((s) => s.enabled).length ?? 0);
const detectedCount = computed(() => sourcesConfig.value?.scrapers.filter((s) => s.enabled && s.detected).length ?? 0);

function scraperEditorState(tool: string): ScraperEditorState {
  if (!scraperEditor[tool]) scraperEditor[tool] = { enabled: true, customStorePath: "" };
  return scraperEditor[tool];
}

// ── Config tab ────────────────────────────────────────────
const policy = ref<EffectivePolicyResponse | null>(null);

// ── Data loading ──────────────────────────────────────────
onMounted(() => { void refresh(); });

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = "";
  flash.value = "";

  const [toolsRes, policyRes, sourcesConfigRes, sourcesDataRes] = await Promise.allSettled([
    apiGet<ContinuityToolsStatusResponse>("/api/continuity/tools-status"),
    apiGet<EffectivePolicyResponse>("/api/continuity/effective-policy"),
    apiGet<SourcesConfigResponse>("/api/sources/config"),
    apiGet<SourcesResponse>("/api/sources"),
  ]);

  if (toolsRes.status === "fulfilled" && policyRes.status === "fulfilled") {
    tools.value = toolsRes.value.tools;
    policy.value = policyRes.value;
    hydrateToolEditor(toolsRes.value.tools, policyRes.value);
  } else {
    error.value = "Failed to load tool configuration.";
  }

  if (sourcesConfigRes.status === "fulfilled") {
    sourcesConfig.value = sourcesConfigRes.value;
    hydrateScraperEditor(sourcesConfigRes.value);
  }

  if (sourcesDataRes.status === "fulfilled") {
    sourcesData.value = sourcesDataRes.value;
  }

  loading.value = false;
}

function hydrateToolEditor(statuses: ToolContinuityStatus[], p: EffectivePolicyResponse): void {
  for (const status of statuses) {
    const pt = p.tools[status.tool];
    editor[status.tool] = {
      enabled: pt?.enabled ?? status.enabled,
      scope: pt?.scope ?? status.scope,
      categories: {
        context_feed: pt?.categories.context_feed ?? status.categories.context_feed,
        skills: pt?.categories.skills ?? status.categories.skills,
        commands: pt?.categories.commands ?? status.categories.commands,
        agents: pt?.categories.agents ?? status.categories.agents,
        mcp_servers: pt?.categories.mcp_servers ?? status.categories.mcp_servers,
        slash_commands: pt?.categories.slash_commands ?? status.categories.slash_commands,
        whitelist_policy: pt?.categories.whitelist_policy ?? status.categories.whitelist_policy,
      },
    };
  }
}

function hydrateScraperEditor(config: SourcesConfigResponse): void {
  for (const scraper of config.scrapers) {
    const entry = scraperEditor[scraper.tool];
    if (!entry) {
      scraperEditor[scraper.tool] = { enabled: scraper.enabled, customStorePath: "" };
    } else {
      entry.enabled = scraper.enabled;
    }
  }
}

// ── Tool actions ──────────────────────────────────────────
async function syncAllTools(): Promise<void> {
  try {
    syncingAll.value = true;
    await apiPost("/api/continuity/sync", {});
    await refresh();
    flash.value = "All tools synchronized.";
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    syncingAll.value = false;
  }
}

async function syncTool(tool: string): Promise<void> {
  try {
    pendingSync[tool] = true;
    await apiPost(`/api/continuity/sync/${encodeURIComponent(tool)}`, {});
    await refresh();
    flash.value = `${tool} synchronized.`;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    pendingSync[tool] = false;
  }
}

async function saveTool(tool: string): Promise<void> {
  const state = editor[tool];
  if (!state) return;
  try {
    pendingSave[tool] = true;
    await apiPut(`/api/continuity/tools/${encodeURIComponent(tool)}`, {
      enabled: state.enabled,
      scope: state.scope,
      categories: state.categories,
    });
    await refresh();
    flash.value = `${tool} policy saved.`;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    pendingSave[tool] = false;
  }
}

async function openPreview(tool: string, mode: "render" | "diff"): Promise<void> {
  try {
    previewMode.value = mode;
    previewVisible.value = true;
    previewLoading.value = true;
    preview.value = await apiGet<ToolRenderPreviewResponse>(`/api/continuity/render/${encodeURIComponent(tool)}`);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    previewLoading.value = false;
  }
}

// ── Source actions ────────────────────────────────────────
async function saveScraper(tool: string): Promise<void> {
  const state = scraperEditor[tool];
  if (!state) return;
  scraperSaving[tool] = true;
  error.value = "";
  flash.value = "";
  try {
    const payload: { enabled: boolean; customStorePath?: string | null } = { enabled: state.enabled };
    const custom = state.customStorePath.trim();
    if (custom.length > 0) payload.customStorePath = custom;
    const res = await apiPut<ScraperConfigUpdateResponse>(`/api/sources/scrapers/${encodeURIComponent(tool)}`, payload);
    if (sourcesConfig.value) sourcesConfig.value.scrapers = res.scrapers;
    flash.value = `${tool} source configuration saved.`;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    scraperSaving[tool] = false;
  }
}

async function resetCustomPath(tool: string): Promise<void> {
  scraperSaving[tool] = true;
  error.value = "";
  flash.value = "";
  try {
    const res = await apiPut<ScraperConfigUpdateResponse>(
      `/api/sources/scrapers/${encodeURIComponent(tool)}`,
      { customStorePath: null },
    );
    if (scraperEditor[tool]) {
      scraperEditor[tool].customStorePath = "";
      scraperEditor[tool].enabled = res.scraper?.enabled ?? scraperEditor[tool].enabled;
    }
    if (sourcesConfig.value) sourcesConfig.value.scrapers = res.scrapers;
    flash.value = `${tool} now uses the default source path.`;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    scraperSaving[tool] = false;
  }
}
</script>

<template>
  <section>
    <!-- Page header -->
    <div class="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 class="xt-title">Tools</h1>
        <p class="mt-1 text-sm text-muted">
          Sync policy, source configuration, and effective policy for all supported assistants.
        </p>
      </div>
      <div class="flex gap-2">
        <button class="xt-btn" type="button" :disabled="syncingAll" @click="syncAllTools">
          {{ syncingAll ? "Syncing…" : "Sync all tools" }}
        </button>
        <button class="xt-btn-ghost" type="button" @click="refresh">Refresh</button>
      </div>
    </div>

    <div v-if="error" class="xt-alert-danger mb-5">{{ error }}</div>
    <div v-if="flash" class="xt-alert-ok mb-5">{{ flash }}</div>

    <!-- Tab strip -->
    <div class="xt-tabs mb-6">
      <button class="xt-tab" :class="{ 'xt-tab-active': tab === 'tools' }" type="button" @click="tab = 'tools'">
        Tools
      </button>
      <button class="xt-tab" :class="{ 'xt-tab-active': tab === 'sources' }" type="button" @click="tab = 'sources'">
        Sources
      </button>
      <button class="xt-tab" :class="{ 'xt-tab-active': tab === 'config' }" type="button" @click="tab = 'config'">
        Config
      </button>
    </div>

    <!-- ── Tools tab ──────────────────────────────────── -->
    <div v-if="tab === 'tools'">
      <div v-if="loading" class="grid gap-4 md:grid-cols-2">
        <div v-for="idx in 4" :key="idx" class="h-64 rounded-lg border bg-surface-2 animate-pulse" />
      </div>

      <div v-else class="grid gap-4 md:grid-cols-2">
        <div
          v-for="toolStatus in orderedTools"
          :key="toolStatus.tool"
          class="rounded-lg border bg-surface-2 p-5 space-y-4"
        >
          <div class="flex flex-wrap items-center justify-between gap-3">
            <h3 class="font-semibold">{{ toolStatus.tool }}</h3>
            <span :class="stateChipClass(toolStatus.state)">{{ stateLabel(toolStatus.state) }}</span>
          </div>

          <label class="flex items-center gap-2.5 text-sm">
            <input
              class="h-4 w-4"
              type="checkbox"
              :checked="editor[toolStatus.tool]?.enabled ?? false"
              @change="onEnabledChange(toolStatus.tool, $event)"
            />
            Enable tool sync
          </label>

          <div>
            <p class="xt-eyebrow mb-1.5">Scope</p>
            <select
              class="xt-select"
              :value="editor[toolStatus.tool]?.scope ?? 'project'"
              @change="onScopeChange(toolStatus.tool, $event)"
            >
              <option v-for="scope in scopeOptions" :key="scope.value" :value="scope.value">{{ scope.label }}</option>
            </select>
          </div>

          <div>
            <p class="xt-eyebrow mb-1.5">Categories</p>
            <div class="grid gap-1.5 sm:grid-cols-2">
              <label
                v-for="(label, key) in categoryLabels"
                :key="key"
                class="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm"
              >
                <input
                  class="h-4 w-4"
                  type="checkbox"
                  :checked="editor[toolStatus.tool]?.categories[key] ?? true"
                  @change="onCategoryChange(toolStatus.tool, key, $event)"
                />
                {{ label }}
              </label>
            </div>
          </div>

          <div v-if="toolStatus.targets.length">
            <p class="xt-eyebrow mb-1.5">Managed targets</p>
            <ul class="space-y-0.5">
              <li v-for="target in toolStatus.targets" :key="target.path">
                <code class="text-xs text-muted">{{ target.path }}</code>
              </li>
            </ul>
          </div>

          <div v-if="toolStatus.warnings.length" class="xt-alert-warn text-xs">
            <ul class="space-y-0.5">
              <li v-for="w in toolStatus.warnings" :key="w">{{ w }}</li>
            </ul>
          </div>

          <div class="flex flex-wrap gap-2 pt-1">
            <button class="xt-btn-ghost text-xs" type="button" @click="openPreview(toolStatus.tool, 'render')">
              Preview output
            </button>
            <button class="xt-btn-ghost text-xs" type="button" @click="openPreview(toolStatus.tool, 'diff')">
              View diff
            </button>
            <button
              class="xt-btn text-xs"
              type="button"
              :disabled="pendingSave[toolStatus.tool]"
              @click="saveTool(toolStatus.tool)"
            >
              {{ pendingSave[toolStatus.tool] ? "Saving…" : "Save policy" }}
            </button>
            <button
              class="xt-btn text-xs"
              type="button"
              :disabled="pendingSync[toolStatus.tool]"
              @click="syncTool(toolStatus.tool)"
            >
              {{ pendingSync[toolStatus.tool] ? "Syncing…" : "Sync" }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ── Sources tab ────────────────────────────────── -->
    <div v-if="tab === 'sources'">
      <!-- Coverage summary — plain KPIs -->
      <div class="mb-8 grid grid-cols-3 gap-6 border-b pb-8">
        <div>
          <p class="xt-kpi-value">{{ detectedCount }}<span class="text-xl text-muted">/{{ enabledCount }}</span></p>
          <p class="xt-kpi-label">Sources detected</p>
        </div>
        <div>
          <p class="xt-kpi-value">{{ sourcesData?.sessions.length ?? 0 }}</p>
          <p class="xt-kpi-label">Recent sessions</p>
        </div>
        <div>
          <p class="xt-kpi-value font-mono text-base leading-normal text-muted">
            {{ sourcesConfig?.pollIntervalMs ?? "—" }}<span class="text-sm"> ms</span>
          </p>
          <p class="xt-kpi-label">Poll interval</p>
        </div>
      </div>

      <!-- Per-tool source config -->
      <h2 class="xt-section-title mb-4">Source configuration</h2>

      <div v-if="loading" class="grid gap-4 md:grid-cols-2">
        <div v-for="idx in 4" :key="idx" class="h-40 rounded-lg border bg-surface-2 animate-pulse" />
      </div>

      <div v-else class="grid gap-4 md:grid-cols-2">
        <div
          v-for="scraper in sourcesConfig?.scrapers ?? []"
          :key="scraper.tool"
          class="rounded-lg border bg-surface-2 p-4 space-y-3"
        >
          <div class="flex items-center justify-between gap-3">
            <h3 class="font-semibold">{{ scraper.tool }}</h3>
            <span :class="scraper.detected ? 'xt-chip-ok' : 'xt-chip-warn'">
              {{ scraper.detected ? "detected" : "not detected" }}
            </span>
          </div>

          <label class="flex items-center gap-2 text-sm">
            <input v-model="scraperEditorState(scraper.tool).enabled" type="checkbox" class="h-4 w-4" />
            Enable ingestion
          </label>

          <div>
            <p class="xt-eyebrow mb-1">Store path</p>
            <code class="block text-xs text-muted">{{ scraper.path }}</code>
          </div>

          <div>
            <p class="xt-eyebrow mb-1">Custom path override</p>
            <input
              v-model="scraperEditorState(scraper.tool).customStorePath"
              class="xt-input"
              placeholder="Leave empty to use default"
            />
          </div>

          <div class="flex flex-wrap gap-2 pt-1">
            <button
              class="xt-btn text-xs"
              type="button"
              :disabled="scraperSaving[scraper.tool]"
              @click="saveScraper(scraper.tool)"
            >
              {{ scraperSaving[scraper.tool] ? "Saving…" : "Save" }}
            </button>
            <button
              class="xt-btn-ghost text-xs"
              type="button"
              :disabled="scraperSaving[scraper.tool]"
              @click="resetCustomPath(scraper.tool)"
            >
              Use default
            </button>
          </div>
        </div>
      </div>

      <!-- Ingested sessions table -->
      <h2 class="xt-section-title mb-4 mt-8">Ingested sessions</h2>
      <div class="overflow-x-auto">
        <table class="xt-table min-w-[560px]">
          <thead>
            <tr>
              <th>Session</th>
              <th>Tool</th>
              <th>Started</th>
              <th>Messages</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="session in sourcesData?.sessions ?? []" :key="session.session_ref">
              <td><code class="text-xs">{{ session.session_ref }}</code></td>
              <td class="text-sm">{{ session.tool }}</td>
              <td class="text-sm text-muted">{{ new Date(session.started_at).toLocaleString() }}</td>
              <td class="text-sm text-muted">{{ session.message_count ?? 0 }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="!loading && (sourcesData?.sessions.length ?? 0) === 0" class="mt-3 text-sm text-muted">
          No sessions ingested yet.
        </p>
      </div>
    </div>

    <!-- ── Config tab ─────────────────────────────────── -->
    <div v-if="tab === 'config'">
      <p class="mb-5 text-sm text-muted">
        Effective policy is the merged result of global baseline + repo policy. Read-only.
      </p>
      <pre
        v-if="policy"
        class="overflow-x-auto rounded-lg border bg-surface-2 p-5 text-xs leading-relaxed"
      >{{ JSON.stringify(policy, null, 2) }}</pre>
      <p v-else-if="loading" class="text-sm text-muted">Loading policy…</p>
      <p v-else class="text-sm text-muted">Policy unavailable.</p>
    </div>

    <!-- ── Preview modal ──────────────────────────────── -->
    <div v-if="previewVisible" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div class="max-h-[90vh] w-[min(1080px,96vw)] overflow-y-auto rounded-xl border bg-surface p-6">
        <div class="mb-4 flex items-center justify-between gap-3">
          <h3 class="font-semibold">{{ preview ? `${preview.tool} output preview` : "Preview" }}</h3>
          <button class="xt-btn-ghost text-xs" type="button" @click="previewVisible = false">Close</button>
        </div>

        <p v-if="previewLoading" class="text-sm text-muted">Loading preview…</p>

        <div v-else-if="preview" class="space-y-4">
          <div>
            <p class="xt-eyebrow mb-2">Rendered output</p>
            <pre class="overflow-x-auto rounded-md border bg-surface-2 p-4 text-xs leading-relaxed">{{ preview.rendered_content }}</pre>
          </div>

          <div v-if="previewMode === 'diff'" class="space-y-4">
            <p class="xt-eyebrow mb-2">Managed block diff</p>
            <div
              v-for="target in preview.targets"
              :key="target.path"
              class="rounded-md border bg-surface-2 p-4 space-y-3"
            >
              <div class="flex flex-wrap items-center justify-between gap-2">
                <code class="text-xs">{{ target.path }}</code>
                <span :class="target.drifted ? 'xt-chip-warn' : 'xt-chip-ok'">
                  {{ target.drifted ? "drifted" : "aligned" }}
                </span>
              </div>
              <div>
                <p class="xt-eyebrow mb-1">Current block</p>
                <pre class="overflow-x-auto rounded-md border bg-surface p-3 text-xs leading-relaxed">{{ target.current_managed_block ?? "(none)" }}</pre>
              </div>
              <div>
                <p class="xt-eyebrow mb-1">Expected block</p>
                <pre class="overflow-x-auto rounded-md border bg-surface p-3 text-xs leading-relaxed">{{ target.expected_managed_block }}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
