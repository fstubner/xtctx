<script setup lang="ts">
import { onMounted, ref } from "vue";
import { apiGet } from "../composables/useApi";
import type { ConfigListResponse } from "../types";

const list = ref<ConfigListResponse | null>(null);
const selectedType = ref<"skill" | "command" | "agent">("skill");
const selectedName = ref("");
const selectedConfig = ref<Record<string, unknown> | null>(null);
const tool = ref("claude-code");
const toolPrefs = ref<Record<string, unknown>>({});
const loading = ref(true);
const error = ref("");

onMounted(async () => {
  await Promise.all([loadList(), loadToolPreferences()]);
});

async function loadList(): Promise<void> {
  loading.value = true;

  try {
    list.value = await apiGet<ConfigListResponse>("/api/config/list", { type: "all" });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function loadConfig(): Promise<void> {
  if (!selectedName.value.trim()) {
    selectedConfig.value = null;
    return;
  }

  try {
    selectedConfig.value = await apiGet<Record<string, unknown>>("/api/config/get", {
      type: selectedType.value,
      name: selectedName.value,
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function loadToolPreferences(): Promise<void> {
  try {
    const result = await apiGet<{ tool: string; preferences: Record<string, unknown> }>(
      "/api/config/preferences",
      { tool: tool.value },
    );
    toolPrefs.value = result.preferences;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}
</script>

<template>
  <section class="space-y-6">
    <header class="space-y-3">
      <p class="xt-eyebrow">Config</p>
      <h2 class="xt-title">Configuration</h2>
      <p class="max-w-3xl text-base leading-relaxed text-muted">
        Inspect synced skills, commands, and agent defaults generated from <code>.xtctx/tool-config</code>.
      </p>
    </header>

    <div v-if="error" class="xt-alert-danger">{{ error }}</div>

    <section class="xt-card">
      <p class="text-sm text-muted">
        Config-first defaults are preferred. Environment variables should be temporary override only.
      </p>
      <p class="mt-2 text-sm text-muted">{{ list?.configs.length ?? 0 }} config entries available.</p>
    </section>

    <div class="grid gap-4 xl:grid-cols-2">
      <section class="xt-card overflow-x-auto">
        <h3 class="xt-section-title mb-4 text-xl">Config inventory</h3>
        <table class="xt-table min-w-[420px]">
          <thead>
            <tr>
              <th>Type</th>
              <th>Name</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in list?.configs ?? []" :key="`${entry.type}-${entry.name}`">
              <td>{{ entry.type }}</td>
              <td>{{ entry.name }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="xt-card space-y-4">
        <h3 class="xt-section-title text-xl">Config lookup</h3>
        <div class="grid gap-3 md:grid-cols-[180px_minmax(0,1fr)_auto] md:items-center">
          <select v-model="selectedType" class="xt-select">
            <option value="skill">skill</option>
            <option value="command">command</option>
            <option value="agent">agent</option>
          </select>
          <input v-model="selectedName" class="xt-input" placeholder="config name" />
          <button class="xt-btn" type="button" @click="loadConfig">Load</button>
        </div>

        <pre class="rounded-lg border bg-surface p-4 text-xs leading-relaxed">{{ selectedConfig ? JSON.stringify(selectedConfig, null, 2) : "No config loaded." }}</pre>
      </section>

      <section class="xt-card space-y-4 xl:col-span-2">
        <h3 class="xt-section-title text-xl">Tool preferences</h3>
        <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
          <input
            v-model="tool"
            class="xt-input"
            placeholder="tool name (example: claude-code)"
            @keydown.enter.prevent="loadToolPreferences"
          />
          <button class="xt-btn-ghost" type="button" @click="loadToolPreferences">Refresh</button>
        </div>

        <pre class="rounded-lg border bg-surface p-4 text-xs leading-relaxed">{{ JSON.stringify(toolPrefs, null, 2) }}</pre>
      </section>
    </div>

    <p v-if="loading" class="text-sm text-muted">Loading config inventory...</p>
  </section>
</template>
