<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { apiGet, getApiBase } from "../composables/useApi";
import type { KnowledgeResponse, SourcesResponse } from "../types";

const loading = ref(true);
const error = ref("");
const sources = ref<SourcesResponse | null>(null);
const knowledge = ref<KnowledgeResponse | null>(null);

const sourceCount = computed(() => sources.value?.sources.length ?? 0);
const knowledgeCount = computed(() => knowledge.value?.count ?? 0);
const sessionCount = computed(() => sources.value?.sessions.length ?? 0);

onMounted(async () => {
  try {
    loading.value = true;
    const [sourceData, knowledgeData] = await Promise.all([
      apiGet<SourcesResponse>("/api/sources"),
      apiGet<KnowledgeResponse>("/api/knowledge", { type: "all" }),
    ]);
    sources.value = sourceData;
    knowledge.value = knowledgeData;
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
      <h1>Dashboard</h1>
      <p>Runtime status for API-backed project context.</p>
    </div>

    <div v-if="loading" class="card">Loading status...</div>
    <div v-else-if="error" class="card error">{{ error }}</div>

    <div v-else class="grid">
      <article class="card stat">
        <h2>{{ sourceCount }}</h2>
        <p>Connected sources</p>
      </article>

      <article class="card stat">
        <h2>{{ knowledgeCount }}</h2>
        <p>Knowledge records</p>
      </article>

      <article class="card stat">
        <h2>{{ sessionCount }}</h2>
        <p>Recent sessions</p>
      </article>

      <article class="card">
        <h3>Project Root</h3>
        <p>{{ sources?.projectRoot }}</p>
      </article>

      <article class="card">
        <h3>API Endpoint</h3>
        <p>{{ getApiBase() }}</p>
      </article>

      <article class="card">
        <h3>Quick Jump</h3>
        <p>Open <RouterLink to="/search">Search</RouterLink> to inspect records or <RouterLink to="/knowledge">Knowledge</RouterLink> to browse curated context.</p>
      </article>
    </div>
  </section>
</template>
