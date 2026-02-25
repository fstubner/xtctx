<script setup lang="ts">
import { ref } from "vue";
import { apiGet } from "../composables/useApi";
import type { SearchResponse } from "../types";

const query = ref("");
const mode = ref<"hybrid" | "semantic" | "keyword">("hybrid");
const loading = ref(false);
const error = ref("");
const results = ref<SearchResponse["results"]>([]);

async function runSearch(): Promise<void> {
  if (!query.value.trim()) {
    results.value = [];
    return;
  }

  try {
    loading.value = true;
    error.value = "";
    const payload = await apiGet<SearchResponse>("/api/search", {
      query: query.value,
      mode: mode.value,
      limit: 10,
    });
    results.value = payload.results;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

function parseMetadata(metadata: string): Record<string, unknown> {
  try {
    return JSON.parse(metadata) as Record<string, unknown>;
  } catch {
    return {};
  }
}
</script>

<template>
  <section class="page">
    <div class="page-head">
      <h1>Search</h1>
      <p>Query indexed project context from the API.</p>
    </div>

    <div class="card search-controls">
      <input
        v-model="query"
        type="text"
        placeholder="Try: vitest setup, postgres error, deployment workflow"
        @keydown.enter.prevent="runSearch"
      />
      <select v-model="mode">
        <option value="hybrid">Hybrid</option>
        <option value="semantic">Semantic</option>
        <option value="keyword">Keyword</option>
      </select>
      <button @click="runSearch" :disabled="loading">
        {{ loading ? "Searching..." : "Search" }}
      </button>
    </div>

    <div v-if="error" class="card error">{{ error }}</div>

    <div class="results">
      <article v-for="item in results" :key="item.id" class="card">
        <header class="result-head">
          <h3>{{ parseMetadata(item.metadata).title ?? item.id }}</h3>
          <span class="score">score {{ item.fusedScore.toFixed(3) }}</span>
        </header>
        <p class="muted">
          {{ parseMetadata(item.metadata).type ?? "unknown" }} ·
          {{ parseMetadata(item.metadata).source_tool ?? "unknown source" }}
        </p>
        <p>{{ item.text }}</p>
      </article>

      <div v-if="!loading && !error && results.length === 0" class="card">
        No results yet. Enter a query to search.
      </div>
    </div>
  </section>
</template>
