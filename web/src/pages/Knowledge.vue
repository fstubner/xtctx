<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { apiGet } from "../composables/useApi";
import type { KnowledgeResponse } from "../types";

const type = ref<"all" | "decision" | "error_solution" | "insight" | "convention" | "gotcha">(
  "all",
);
const query = ref("");
const loading = ref(false);
const error = ref("");
const data = ref<KnowledgeResponse>({ type: "all", count: 0, records: [] });

async function loadKnowledge(): Promise<void> {
  try {
    loading.value = true;
    error.value = "";
    data.value = await apiGet<KnowledgeResponse>("/api/knowledge", {
      type: type.value,
      query: query.value || undefined,
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(loadKnowledge);
watch(type, loadKnowledge);
</script>

<template>
  <section class="page">
    <div class="page-head">
      <h1>Knowledge</h1>
      <p>Decisions, fixes, and insights stored in `.xtctx/knowledge`.</p>
    </div>

    <div class="card search-controls">
      <select v-model="type">
        <option value="all">All</option>
        <option value="decision">Decision</option>
        <option value="error_solution">Error Solution</option>
        <option value="insight">Insight</option>
        <option value="convention">Convention</option>
        <option value="gotcha">Gotcha</option>
      </select>
      <input
        v-model="query"
        type="text"
        placeholder="Filter by keyword"
        @keydown.enter.prevent="loadKnowledge"
      />
      <button @click="loadKnowledge" :disabled="loading">
        {{ loading ? "Loading..." : "Apply" }}
      </button>
    </div>

    <div v-if="error" class="card error">{{ error }}</div>

    <div class="results">
      <article v-for="record in data.records" :key="record.id" class="card">
        <header class="result-head">
          <h3>{{ record.title }}</h3>
          <span class="pill">{{ record.type }}</span>
        </header>
        <p class="muted">{{ record.source_tool }} · {{ new Date(record.created_at).toLocaleString() }}</p>
        <p>{{ record.body }}</p>
        <p v-if="record.domain_tags.length" class="muted">
          tags: {{ record.domain_tags.join(", ") }}
        </p>
      </article>

      <div v-if="!loading && !error && data.records.length === 0" class="card">
        No records match the selected filters.
      </div>
    </div>
  </section>
</template>
