<script setup lang="ts">
import { ref } from "vue";
import { apiGet } from "../composables/useApi";
import type { SearchResponse } from "../types";

const query = ref("");
const mode = ref<"hybrid" | "semantic" | "keyword">("hybrid");
const loading = ref(false);
const error = ref("");
const results = ref<SearchResponse["results"]>([]);
const hasSearched = ref(false);

const starterPrompts = [
  "authentication error after dependency update",
  "why did we choose this architecture",
  "database migration strategy",
  "environment variable configuration",
];

async function runSearch(): Promise<void> {
  if (!query.value.trim()) {
    hasSearched.value = false;
    results.value = [];
    return;
  }

  loading.value = true;
  error.value = "";
  hasSearched.value = true;

  try {
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

function usePrompt(prompt: string): void {
  query.value = prompt;
  void runSearch();
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
  <section class="space-y-6">
    <header class="space-y-3">
      <p class="xt-eyebrow">Recall</p>
      <h2 class="xt-title">Search memory</h2>
      <p class="max-w-3xl text-base leading-relaxed text-muted">
        Query prior conversations and project records before editing. Start with concrete failure language.
      </p>
    </header>

    <section class="xt-card space-y-4">
      <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_auto] md:items-center">
        <input
          v-model="query"
          class="xt-input"
          placeholder="Try: npm publish failed with provenance validation"
          @keydown.enter.prevent="runSearch"
        />
        <select v-model="mode" class="xt-select">
          <option value="hybrid">Hybrid</option>
          <option value="semantic">Semantic</option>
          <option value="keyword">Keyword</option>
        </select>
        <button class="xt-btn" type="button" :disabled="loading" @click="runSearch">
          {{ loading ? "Searching..." : "Search" }}
        </button>
      </div>

      <div class="flex flex-wrap gap-2">
        <button
          v-for="prompt in starterPrompts"
          :key="prompt"
          class="xt-btn-ghost"
          type="button"
          @click="usePrompt(prompt)"
        >
          {{ prompt }}
        </button>
      </div>
    </section>

    <div v-if="error" class="xt-alert-danger">{{ error }}</div>

    <section v-if="results.length > 0" class="space-y-4">
      <article v-for="item in results" :key="item.id" class="xt-card space-y-3">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <h3 class="text-lg font-semibold">{{ parseMetadata(item.metadata).title ?? item.id }}</h3>
          <span class="xt-chip-neutral">score {{ item.fusedScore.toFixed(3) }}</span>
        </div>

        <p class="text-sm text-muted">
          {{ parseMetadata(item.metadata).type ?? "unknown" }}
          ·
          {{ parseMetadata(item.metadata).source_tool ?? "unknown source" }}
        </p>

        <p class="text-base leading-relaxed">{{ item.text }}</p>

        <div class="flex flex-wrap gap-2">
          <span class="xt-chip-neutral">{{ String(parseMetadata(item.metadata).source_path ?? "no source path") }}</span>
        </div>
      </article>
    </section>

    <section v-else class="xt-card space-y-2">
      <h3 class="text-lg font-semibold">
        {{ hasSearched ? "No matching context found." : "No query yet." }}
      </h3>
      <p class="text-base leading-relaxed text-muted" v-if="hasSearched">
        Broaden the phrase or use hybrid mode to mix keyword and semantic retrieval.
      </p>
      <p class="text-base leading-relaxed text-muted" v-else>
        Start from one of the prompts above or paste a task-specific error string.
      </p>
    </section>
  </section>
</template>
