<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { apiGet } from "../composables/useApi";
import type { KnowledgeResponse, SearchResponse } from "../types";

// ── Tab ───────────────────────────────────────────────────
type ActiveTab = "search" | "knowledge";
const tab = ref<ActiveTab>("search");

// ── Search ────────────────────────────────────────────────
const searchQuery = ref("");
const searchMode = ref<"hybrid" | "semantic" | "keyword">("hybrid");
const searchLoading = ref(false);
const searchError = ref("");
const searchResults = ref<SearchResponse["results"]>([]);
const hasSearched = ref(false);

const starterPrompts = [
  "authentication error after dependency update",
  "why did we choose this architecture",
  "database migration strategy",
  "environment variable configuration",
];

async function runSearch(): Promise<void> {
  if (!searchQuery.value.trim()) {
    hasSearched.value = false;
    searchResults.value = [];
    return;
  }

  searchLoading.value = true;
  searchError.value = "";
  hasSearched.value = true;

  try {
    const payload = await apiGet<SearchResponse>("/api/search", {
      query: searchQuery.value,
      mode: searchMode.value,
      limit: 10,
    });
    searchResults.value = payload.results;
  } catch (err) {
    searchError.value = err instanceof Error ? err.message : String(err);
  } finally {
    searchLoading.value = false;
  }
}

function usePrompt(prompt: string): void {
  searchQuery.value = prompt;
  void runSearch();
}

function parseMetadata(metadata: string): Record<string, unknown> {
  try {
    return JSON.parse(metadata) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ── Knowledge ─────────────────────────────────────────────
type KnowledgeType = "all" | "decision" | "error_solution" | "insight" | "convention" | "gotcha" | "faq";

const knowledgeType = ref<KnowledgeType>("all");
const knowledgeQuery = ref("");
const knowledgeLoading = ref(false);
const knowledgeError = ref("");
const knowledgeData = ref<KnowledgeResponse>({ type: "all", count: 0, records: [] });

const typeOptions: Array<{ label: string; value: KnowledgeType }> = [
  { label: "All", value: "all" },
  { label: "Decision", value: "decision" },
  { label: "Error solution", value: "error_solution" },
  { label: "Insight", value: "insight" },
  { label: "Convention", value: "convention" },
  { label: "Gotcha", value: "gotcha" },
  { label: "FAQ", value: "faq" },
];

const typeCounts = computed(() => {
  const counts = new Map<KnowledgeType, number>([
    ["decision", 0], ["error_solution", 0], ["insight", 0],
    ["convention", 0], ["gotcha", 0], ["faq", 0],
    ["all", knowledgeData.value.records.length],
  ]);
  for (const record of knowledgeData.value.records) {
    const key = record.type as KnowledgeType;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
});

async function loadKnowledge(): Promise<void> {
  knowledgeLoading.value = true;
  knowledgeError.value = "";
  try {
    knowledgeData.value = await apiGet<KnowledgeResponse>("/api/knowledge", {
      type: knowledgeType.value,
      query: knowledgeQuery.value || undefined,
    });
  } catch (err) {
    knowledgeError.value = err instanceof Error ? err.message : String(err);
  } finally {
    knowledgeLoading.value = false;
  }
}

function typeBadge(typeValue: string): string {
  if (typeValue === "decision") return "xt-chip-ok";
  if (typeValue === "error_solution") return "xt-chip-danger";
  if (typeValue === "convention") return "xt-chip-warn";
  return "xt-chip-neutral";
}

onMounted(loadKnowledge);
watch(knowledgeType, loadKnowledge);
</script>

<template>
  <section>
    <div class="mb-6">
      <h1 class="xt-title">Memory</h1>
      <p class="mt-1 text-sm text-muted">
        Search indexed context before editing. Browse structured project knowledge.
      </p>
    </div>

    <!-- Tab strip -->
    <div class="xt-tabs mb-6">
      <button
        class="xt-tab"
        :class="{ 'xt-tab-active': tab === 'search' }"
        type="button"
        @click="tab = 'search'"
      >
        Search
      </button>
      <button
        class="xt-tab"
        :class="{ 'xt-tab-active': tab === 'knowledge' }"
        type="button"
        @click="tab = 'knowledge'"
      >
        Knowledge
      </button>
    </div>

    <!-- ── Search tab ───────────────────────────────────── -->
    <div v-if="tab === 'search'">
      <div class="mb-5 space-y-3">
        <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_160px_auto] md:items-center">
          <input
            v-model="searchQuery"
            class="xt-input"
            placeholder="Try: npm publish failed with provenance validation"
            @keydown.enter.prevent="runSearch"
          />
          <select v-model="searchMode" class="xt-select">
            <option value="hybrid">Hybrid</option>
            <option value="semantic">Semantic</option>
            <option value="keyword">Keyword</option>
          </select>
          <button class="xt-btn" type="button" :disabled="searchLoading" @click="runSearch">
            {{ searchLoading ? "Searching…" : "Search" }}
          </button>
        </div>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="prompt in starterPrompts"
            :key="prompt"
            class="xt-btn-ghost text-xs"
            type="button"
            @click="usePrompt(prompt)"
          >
            {{ prompt }}
          </button>
        </div>
      </div>

      <div v-if="searchError" class="xt-alert-danger mb-4">{{ searchError }}</div>

      <div v-if="searchResults.length > 0" class="space-y-px">
        <div
          v-for="item in searchResults"
          :key="item.id"
          class="border-t py-4 first:border-t-0"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <p class="font-semibold">{{ parseMetadata(item.metadata).title ?? item.id }}</p>
            <span class="xt-chip-neutral font-mono">{{ item.fusedScore.toFixed(3) }}</span>
          </div>
          <p class="mt-1 text-xs text-muted">
            {{ parseMetadata(item.metadata).type ?? "unknown" }}
            · {{ parseMetadata(item.metadata).source_tool ?? "unknown source" }}
          </p>
          <p class="mt-2 text-sm leading-relaxed">{{ item.text }}</p>
          <p class="mt-1 font-mono text-xs text-muted">
            {{ String(parseMetadata(item.metadata).source_path ?? "") }}
          </p>
        </div>
      </div>

      <div v-else class="pt-2 text-sm text-muted">
        <template v-if="hasSearched">
          No matching context found. Broaden the phrase or switch to hybrid mode.
        </template>
        <template v-else>
          Start from a prompt above or paste a task-specific error string.
        </template>
      </div>
    </div>

    <!-- ── Knowledge tab ────────────────────────────────── -->
    <div v-if="tab === 'knowledge'">
      <div class="mb-5 space-y-3">
        <div class="grid gap-3 md:grid-cols-[200px_minmax(0,1fr)_auto_auto] md:items-center">
          <select v-model="knowledgeType" class="xt-select">
            <option v-for="opt in typeOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
          <input
            v-model="knowledgeQuery"
            class="xt-input"
            placeholder="Filter by keyword"
            @keydown.enter.prevent="loadKnowledge"
          />
          <button class="xt-btn" type="button" :disabled="knowledgeLoading" @click="loadKnowledge">
            {{ knowledgeLoading ? "Loading…" : "Apply" }}
          </button>
          <span class="xt-chip-neutral">{{ knowledgeData.records.length }} records</span>
        </div>
        <div class="flex flex-wrap gap-3">
          <span
            v-for="opt in typeOptions.filter((o) => o.value !== 'all')"
            :key="opt.value"
            class="text-xs text-muted"
          >
            {{ opt.label }}: <span class="font-medium text-text">{{ typeCounts.get(opt.value) ?? 0 }}</span>
          </span>
        </div>
      </div>

      <div v-if="knowledgeError" class="xt-alert-danger mb-4">{{ knowledgeError }}</div>

      <div v-if="knowledgeData.records.length > 0">
        <div
          v-for="record in knowledgeData.records"
          :key="record.id"
          class="border-t py-5 first:border-t-0"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <p class="font-semibold">{{ record.title }}</p>
            <span :class="typeBadge(record.type)">{{ record.type }}</span>
          </div>
          <p class="mt-1 text-xs text-muted">
            {{ record.source_tool }} · {{ new Date(record.created_at).toLocaleString() }}
          </p>
          <p class="mt-2 text-sm leading-relaxed">{{ record.body }}</p>
          <div v-if="record.domain_tags.length" class="mt-2 flex flex-wrap gap-1.5">
            <span
              v-for="tag in record.domain_tags"
              :key="`${record.id}-${tag}`"
              class="xt-chip-neutral"
            >{{ tag }}</span>
          </div>
        </div>
      </div>

      <div v-else class="pt-2 text-sm text-muted">
        No records match this filter. Switch to All, broaden your query, or write back a new record.
      </div>
    </div>
  </section>
</template>
