<script setup lang="ts">
import { onMounted, ref } from "vue";
import { apiGet } from "../composables/useApi";
import type { SourcesResponse } from "../types";

const loading = ref(true);
const error = ref("");
const data = ref<SourcesResponse | null>(null);

onMounted(async () => {
  try {
    loading.value = true;
    data.value = await apiGet<SourcesResponse>("/api/sources");
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section class="page">
    <div class="page-head">
      <h1>Sources</h1>
      <p>Data sources and scraper status for this project.</p>
    </div>

    <div v-if="loading" class="card">Loading sources...</div>
    <div v-else-if="error" class="card error">{{ error }}</div>

    <div v-else-if="data" class="grid">
      <article v-for="source in data.sources" :key="source.name" class="card">
        <header class="result-head">
          <h3>{{ source.name }}</h3>
          <span class="pill">{{ source.kind }}</span>
        </header>
        <p class="muted">{{ source.path }}</p>
        <p v-if="source.records !== undefined">records: {{ source.records }}</p>
        <p v-if="source.detected !== undefined">
          detected: <strong>{{ source.detected ? "yes" : "no" }}</strong>
        </p>
      </article>

      <article class="card">
        <h3>Recent Sessions</h3>
        <ul v-if="data.sessions.length">
          <li v-for="session in data.sessions" :key="session.session_ref">
            {{ session.session_ref }} · {{ session.tool }}
          </li>
        </ul>
        <p v-else class="muted">No sessions available yet.</p>
      </article>
    </div>
  </section>
</template>
