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
  try {
    loading.value = true;
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
    const result = await apiGet<Record<string, unknown>>("/api/config/get", {
      type: selectedType.value,
      name: selectedName.value,
    });
    selectedConfig.value = result;
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
  <section class="page">
    <div class="page-head">
      <h1>Config</h1>
      <p>Shared config view for skills, commands, agents, and tool preferences.</p>
    </div>

    <div v-if="loading" class="card">Loading config...</div>
    <div v-else-if="error" class="card error">{{ error }}</div>

    <div v-else class="grid">
      <article class="card">
        <h3>Config Inventory</h3>
        <p class="muted">entries: {{ list?.count ?? 0 }}</p>
        <ul>
          <li v-for="item in list?.configs ?? []" :key="`${item.type}:${item.name}`">
            {{ item.type }} · {{ item.name }}
          </li>
        </ul>
      </article>

      <article class="card">
        <h3>Get Config</h3>
        <div class="search-controls compact">
          <select v-model="selectedType">
            <option value="skill">skill</option>
            <option value="command">command</option>
            <option value="agent">agent</option>
          </select>
          <input v-model="selectedName" type="text" placeholder="config name" />
          <button @click="loadConfig">Load</button>
        </div>
        <pre>{{ selectedConfig ? JSON.stringify(selectedConfig, null, 2) : "No config loaded." }}</pre>
      </article>

      <article class="card">
        <h3>Tool Preferences</h3>
        <div class="search-controls compact">
          <input v-model="tool" type="text" placeholder="tool name (e.g. claude-code)" />
          <button @click="loadToolPreferences">Refresh</button>
        </div>
        <pre>{{ JSON.stringify(toolPrefs, null, 2) }}</pre>
      </article>
    </div>
  </section>
</template>
