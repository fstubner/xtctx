<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { apiGet, apiPost, apiPut } from "../composables/useApi";
import type {
  ContinuityCategory,
  ContinuityScope,
  ContinuityToolsStatusResponse,
  EffectivePolicyResponse,
  ToolRenderPreviewResponse,
  ToolContinuityStatus,
} from "../types";

interface ToolEditorState {
  enabled: boolean;
  scope: ContinuityScope;
  categories: Record<ContinuityCategory, boolean>;
}

const loading = ref(true);
const syncingAll = ref(false);
const error = ref("");
const flash = ref("");
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

onMounted(() => {
  void refresh();
});

async function refresh(): Promise<void> {
  try {
    loading.value = true;
    error.value = "";

    const [statusPayload, policy] = await Promise.all([
      apiGet<ContinuityToolsStatusResponse>("/api/continuity/tools-status"),
      apiGet<EffectivePolicyResponse>("/api/continuity/effective-policy"),
    ]);

    tools.value = statusPayload.tools;
    hydrateEditor(statusPayload.tools, policy);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

function hydrateEditor(statuses: ToolContinuityStatus[], policy: EffectivePolicyResponse): void {
  for (const status of statuses) {
    const policyTool = policy.tools[status.tool];
    editor[status.tool] = {
      enabled: policyTool?.enabled ?? status.enabled,
      scope: policyTool?.scope ?? status.scope,
      categories: {
        context_feed: policyTool?.categories.context_feed ?? status.categories.context_feed,
        skills: policyTool?.categories.skills ?? status.categories.skills,
        commands: policyTool?.categories.commands ?? status.categories.commands,
        agents: policyTool?.categories.agents ?? status.categories.agents,
        mcp_servers: policyTool?.categories.mcp_servers ?? status.categories.mcp_servers,
        slash_commands: policyTool?.categories.slash_commands ?? status.categories.slash_commands,
        whitelist_policy: policyTool?.categories.whitelist_policy ?? status.categories.whitelist_policy,
      },
    };
  }
}

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
  if (!state) {
    return;
  }

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

function stateLabel(state: ToolContinuityStatus["state"]): string {
  if (state === "disabled_by_policy") {
    return "disabled by policy";
  }

  return state.replace(/_/g, " ");
}

function stateChipClass(state: ToolContinuityStatus["state"]): string {
  if (state === "in_sync") return "xt-chip-ok";
  if (state === "missing_target") return "xt-chip-warn";
  if (state === "drifted") return "xt-chip-danger";
  return "xt-chip-neutral";
}

function toolOrder(tool: string): number {
  const order = ["claude", "claude-code", "cursor", "codex", "copilot", "gemini"];
  const index = order.indexOf(tool);
  return index === -1 ? 99 : index;
}

function setToolEnabled(tool: string, value: boolean): void {
  ensureToolEditor(tool).enabled = value;
}

function setToolScope(tool: string, value: ContinuityScope): void {
  ensureToolEditor(tool).scope = value;
}

function setToolCategory(tool: string, category: ContinuityCategory, value: boolean): void {
  ensureToolEditor(tool).categories[category] = value;
}

function updateScope(tool: string, value: string): void {
  if (value === "project" || value === "global" || value === "hybrid") {
    setToolScope(tool, value);
  }
}

function readCategory(tool: string, key: ContinuityCategory): boolean {
  return ensureToolEditor(tool).categories[key];
}

function updateCategory(tool: string, key: ContinuityCategory, value: boolean): void {
  setToolCategory(tool, key, value);
}

function onEnabledChange(tool: string, event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }

  setToolEnabled(tool, target.checked);
}

function onScopeChange(tool: string, event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) {
    return;
  }

  updateScope(tool, target.value);
}

function onCategoryChange(tool: string, key: ContinuityCategory, event: Event): void {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }

  updateCategory(tool, key, target.checked);
}

function ensureToolEditor(tool: string): ToolEditorState {
  if (!editor[tool]) {
    editor[tool] = {
      enabled: true,
      scope: "project",
      categories: {
        context_feed: true,
        skills: true,
        commands: true,
        agents: true,
        mcp_servers: true,
        slash_commands: true,
        whitelist_policy: true,
      },
    };
  }

  return editor[tool];
}
</script>

<template>
  <section class="space-y-6">
    <header class="space-y-3">
      <p class="xt-eyebrow">Orchestration</p>
      <h2 class="xt-title">Tools</h2>
      <p class="max-w-3xl text-base leading-relaxed text-muted">
        Configure continuity by tool: scope, category propagation, managed targets, and drift reconciliation.
      </p>
    </header>

    <div v-if="error" class="xt-alert-danger">{{ error }}</div>
    <div v-if="flash" class="xt-alert-warn">{{ flash }}</div>

    <section class="xt-card flex flex-wrap items-center justify-between gap-4">
      <p class="text-sm text-muted">Defaults are sync-on with category-level opt-out per tool.</p>
      <button class="xt-btn" type="button" :disabled="syncingAll" @click="syncAllTools">
        {{ syncingAll ? "Syncing..." : "Sync all tools" }}
      </button>
    </section>

    <div v-if="loading" class="grid gap-4 lg:grid-cols-2">
      <article v-for="idx in 4" :key="idx" class="xt-card h-64 animate-pulse" />
    </div>

    <div v-else class="grid gap-4 lg:grid-cols-2">
      <article v-for="toolStatus in orderedTools" :key="toolStatus.tool" class="xt-card space-y-5">
        <header class="flex flex-wrap items-center justify-between gap-3">
          <h3 class="xt-section-title text-xl">{{ toolStatus.tool }}</h3>
          <span :class="stateChipClass(toolStatus.state)">{{ stateLabel(toolStatus.state) }}</span>
        </header>

        <div class="grid gap-4">
          <label class="flex items-center gap-3 text-sm">
            <input
              class="h-4 w-4"
              type="checkbox"
              :checked="editor[toolStatus.tool]?.enabled ?? false"
              @change="onEnabledChange(toolStatus.tool, $event)"
            />
            Enable tool sync
          </label>

          <div class="space-y-2">
            <p class="xt-eyebrow">Scope</p>
            <select
              class="xt-select"
              :value="editor[toolStatus.tool]?.scope ?? 'project'"
              @change="onScopeChange(toolStatus.tool, $event)"
            >
              <option v-for="scope in scopeOptions" :key="scope.value" :value="scope.value">{{ scope.label }}</option>
            </select>
          </div>

          <div class="space-y-2">
            <p class="xt-eyebrow">Core categories</p>
            <div class="grid gap-2 sm:grid-cols-2">
              <label v-for="(label, key) in categoryLabels" :key="key" class="flex items-center gap-2 rounded-lg border bg-surface px-3 py-2 text-sm">
                <input
                  class="h-4 w-4"
                  type="checkbox"
                  :checked="readCategory(toolStatus.tool, key)"
                  @change="onCategoryChange(toolStatus.tool, key, $event)"
                />
                {{ label }}
              </label>
            </div>
          </div>

          <div class="space-y-2">
            <p class="xt-eyebrow">Managed targets</p>
            <ul class="list-disc space-y-1 pl-5 text-sm">
              <li v-for="target in toolStatus.targets" :key="target.path"><code>{{ target.path }}</code></li>
            </ul>
          </div>

          <div v-if="toolStatus.warnings.length > 0" class="space-y-2">
            <p class="xt-eyebrow">Warnings</p>
            <ul class="list-disc space-y-1 pl-5 text-sm text-muted">
              <li v-for="warning in toolStatus.warnings" :key="warning">{{ warning }}</li>
            </ul>
          </div>

          <div class="flex flex-wrap gap-2">
            <button class="xt-btn-ghost" type="button" @click="openPreview(toolStatus.tool, 'render')">View rendered output</button>
            <button class="xt-btn-ghost" type="button" @click="openPreview(toolStatus.tool, 'diff')">View managed block diff</button>
            <button class="xt-btn" type="button" :disabled="pendingSave[toolStatus.tool]" @click="saveTool(toolStatus.tool)">
              {{ pendingSave[toolStatus.tool] ? "Saving..." : "Save policy" }}
            </button>
            <button class="xt-btn" type="button" :disabled="pendingSync[toolStatus.tool]" @click="syncTool(toolStatus.tool)">
              {{ pendingSync[toolStatus.tool] ? "Syncing..." : "Sync this tool" }}
            </button>
          </div>
        </div>
      </article>
    </div>

    <div v-if="previewVisible" class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div class="max-h-[90vh] w-[min(1080px,96vw)] overflow-y-auto rounded-xl border bg-surface p-6 shadow-soft">
        <div class="mb-4 flex items-center justify-between gap-3">
          <h3 class="xt-section-title text-xl">{{ preview ? `${preview.tool} preview` : "Preview" }}</h3>
          <button class="xt-btn-ghost" type="button" @click="previewVisible = false">Close</button>
        </div>

        <p v-if="previewLoading" class="text-sm text-muted">Loading preview...</p>

        <div v-else-if="preview" class="space-y-4">
          <section class="xt-card space-y-2">
            <p class="xt-eyebrow">Rendered output</p>
            <pre class="overflow-x-auto rounded-lg border bg-surface p-4 text-xs leading-relaxed">{{ preview.rendered_content }}</pre>
          </section>

          <section v-if="previewMode === 'diff'" class="xt-card space-y-4">
            <p class="xt-eyebrow">Managed block diff</p>
            <article v-for="target in preview.targets" :key="target.path" class="space-y-3 rounded-lg border bg-surface p-4">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <code class="text-xs">{{ target.path }}</code>
                <span :class="target.drifted ? 'xt-chip-warn' : 'xt-chip-ok'">
                  {{ target.drifted ? "drifted" : "aligned" }}
                </span>
              </div>
              <div class="space-y-1">
                <p class="xt-eyebrow">Current managed block</p>
                <pre class="overflow-x-auto rounded-lg border bg-surface-2 p-3 text-xs leading-relaxed">{{ target.current_managed_block ?? "(none)" }}</pre>
              </div>
              <div class="space-y-1">
                <p class="xt-eyebrow">Expected managed block</p>
                <pre class="overflow-x-auto rounded-lg border bg-surface-2 p-3 text-xs leading-relaxed">{{ target.expected_managed_block }}</pre>
              </div>
            </article>
          </section>
        </div>
      </div>
    </div>
  </section>
</template>
