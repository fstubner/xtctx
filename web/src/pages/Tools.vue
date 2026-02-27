<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import Button from "primevue/button";
import Card from "primevue/card";
import Checkbox from "primevue/checkbox";
import Message from "primevue/message";
import SelectButton from "primevue/selectbutton";
import Tag from "primevue/tag";
import { useToast } from "primevue/usetoast";
import { apiGet, apiPost, apiPut } from "../composables/useApi";
import type {
  ContinuityCategory,
  ContinuityScope,
  ContinuityToolsStatusResponse,
  EffectivePolicyResponse,
  ToolContinuityStatus,
} from "../types";

interface ToolEditorState {
  enabled: boolean;
  scope: ContinuityScope;
  categories: Record<ContinuityCategory, boolean>;
}

const toast = useToast();

const loading = ref(true);
const syncingAll = ref(false);
const error = ref("");
const tools = ref<ToolContinuityStatus[]>([]);
const editor = reactive<Record<string, ToolEditorState>>({});
const pendingSave = reactive<Record<string, boolean>>({});
const pendingSync = reactive<Record<string, boolean>>({});

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

const orderedTools = computed(() =>
  [...tools.value].sort((a, b) => toolOrder(a.tool) - toolOrder(b.tool)),
);

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

function hydrateEditor(
  statuses: ToolContinuityStatus[],
  policy: EffectivePolicyResponse,
): void {
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
        whitelist_policy:
          policyTool?.categories.whitelist_policy ?? status.categories.whitelist_policy,
      },
    };
  }
}

async function syncAllTools(): Promise<void> {
  try {
    syncingAll.value = true;
    await apiPost("/api/continuity/sync", {});
    await refresh();
    toast.add({
      severity: "success",
      summary: "Continuity synchronized",
      detail: "All tools were reconciled against policy.",
      life: 2500,
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    toast.add({
      severity: "error",
      summary: "Sync failed",
      detail: error.value,
      life: 3500,
    });
  } finally {
    syncingAll.value = false;
  }
}

async function syncTool(tool: string): Promise<void> {
  try {
    pendingSync[tool] = true;
    await apiPost(`/api/continuity/sync/${encodeURIComponent(tool)}`, {});
    await refresh();
    toast.add({
      severity: "success",
      summary: `${tool} synced`,
      detail: "Managed blocks were reconciled.",
      life: 2200,
    });
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
    toast.add({
      severity: "success",
      summary: `${tool} policy saved`,
      detail: "Scope and category settings were persisted.",
      life: 2200,
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    toast.add({
      severity: "error",
      summary: "Save failed",
      detail: error.value,
      life: 3500,
    });
  } finally {
    pendingSave[tool] = false;
  }
}

function statusSeverity(state: ToolContinuityStatus["state"]) {
  if (state === "in_sync") {
    return "success";
  }

  if (state === "missing_target") {
    return "warn";
  }

  if (state === "disabled_by_policy") {
    return "secondary";
  }

  return "danger";
}

function stateLabel(state: ToolContinuityStatus["state"]): string {
  if (state === "disabled_by_policy") {
    return "disabled by policy";
  }

  return state.replace(/_/g, " ");
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

function updateScope(tool: string, value: unknown): void {
  if (value === "project" || value === "global" || value === "hybrid") {
    setToolScope(tool, value);
  }
}

function readCategory(tool: string, key: string): boolean {
  if (!isContinuityCategory(key)) {
    return false;
  }

  return ensureToolEditor(tool).categories[key];
}

function updateCategory(tool: string, key: string, value: boolean): void {
  if (!isContinuityCategory(key)) {
    return;
  }

  setToolCategory(tool, key, value);
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

function isContinuityCategory(value: string): value is ContinuityCategory {
  return value in categoryLabels;
}
</script>

<template>
  <section class="page-shell">
    <div class="page-head">
      <p class="page-eyebrow">Orchestration</p>
      <h2>Tools</h2>
      <p>
        Configure continuity per assistant: choose scope, category propagation,
        then sync managed targets.
      </p>
    </div>

    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <Card class="surface-card">
      <template #content>
        <div class="tools-head-actions">
          <p class="helper-copy">Defaults are sync-on with category-level opt-out by tool.</p>
          <Button
            label="Sync all tools"
            icon="pi pi-refresh"
            :loading="syncingAll"
            @click="syncAllTools"
          />
        </div>
      </template>
    </Card>

    <div v-if="loading" class="tools-grid">
      <Card v-for="i in 4" :key="i" class="surface-card">
        <template #content>
          <div class="tool-placeholder" />
        </template>
      </Card>
    </div>

    <div v-else class="tools-grid">
      <Card
        v-for="toolStatus in orderedTools"
        :key="toolStatus.tool"
        class="surface-card tool-card"
      >
        <template #title>
          <div class="tool-card-head">
            <h3>{{ toolStatus.tool }}</h3>
            <Tag :severity="statusSeverity(toolStatus.state)" :value="stateLabel(toolStatus.state)" />
          </div>
        </template>

        <template #content>
          <div class="tool-card-body">
            <div class="tool-row">
              <label class="tool-field-label">Enabled</label>
              <Checkbox
                :modelValue="editor[toolStatus.tool]?.enabled ?? false"
                binary
                @update:modelValue="setToolEnabled(toolStatus.tool, Boolean($event))"
              />
            </div>

            <div class="tool-row">
              <label class="tool-field-label">Scope</label>
              <SelectButton
                :modelValue="editor[toolStatus.tool]?.scope ?? 'project'"
                :options="scopeOptions"
                optionLabel="label"
                optionValue="value"
                aria-label="Scope"
                @update:modelValue="updateScope(toolStatus.tool, $event)"
              />
            </div>

            <div class="tool-categories">
              <p class="tool-field-label">Core 7 categories</p>
              <div class="tool-category-grid">
                <label
                  v-for="(label, key) in categoryLabels"
                  :key="key"
                  class="tool-category-item"
                >
                  <Checkbox
                    :modelValue="readCategory(toolStatus.tool, key)"
                    binary
                    @update:modelValue="updateCategory(toolStatus.tool, key, Boolean($event))"
                  />
                  <span>{{ label }}</span>
                </label>
              </div>
            </div>

            <div class="tool-targets">
              <p class="tool-field-label">Managed targets</p>
              <ul>
                <li v-for="target in toolStatus.targets" :key="target.path">
                  <code>{{ target.path }}</code>
                </li>
              </ul>
            </div>

            <div v-if="toolStatus.warnings.length > 0" class="tool-warnings">
              <p class="tool-field-label">Warnings</p>
              <ul>
                <li v-for="warning in toolStatus.warnings" :key="warning">{{ warning }}</li>
              </ul>
            </div>

            <div class="tool-actions">
              <Button
                label="Save policy"
                icon="pi pi-save"
                outlined
                :loading="pendingSave[toolStatus.tool]"
                @click="saveTool(toolStatus.tool)"
              />
              <Button
                label="Sync this tool"
                icon="pi pi-refresh"
                :loading="pendingSync[toolStatus.tool]"
                @click="syncTool(toolStatus.tool)"
              />
            </div>
          </div>
        </template>
      </Card>
    </div>
  </section>
</template>
