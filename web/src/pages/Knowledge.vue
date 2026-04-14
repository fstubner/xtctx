<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { apiGet } from "../composables/useApi";
import type { KnowledgeResponse } from "../types";

type KnowledgeType =
  | "all"
  | "decision"
  | "error_solution"
  | "insight"
  | "convention"
  | "gotcha"
  | "faq";

const type = ref<KnowledgeType>("all");
const query = ref("");
const loading = ref(false);
const error = ref("");
const data = ref<KnowledgeResponse>({ type: "all", count: 0, records: [] });

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
    ["decision", 0],
    ["error_solution", 0],
    ["insight", 0],
    ["convention", 0],
    ["gotcha", 0],
    ["faq", 0],
    ["all", data.value.records.length],
  ]);

  for (const record of data.value.records) {
    const key = record.type as KnowledgeType;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
});

async function loadKnowledge(): Promise<void> {
  loading.value = true;
  error.value = "";

  try {
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

function typeBadge(typeValue: string): string {
  if (typeValue === "decision") return "xt-chip-ok";
  if (typeValue === "error_solution") return "xt-chip-danger";
  if (typeValue === "faq") return "xt-chip-neutral";
  if (typeValue === "convention") return "xt-chip-warn";
  return "xt-chip-neutral";
}

onMounted(loadKnowledge);
watch(type, loadKnowledge);
</script>

<template>
  <section class="space-y-6">
    <header class="space-y-3">
      <p class="xt-eyebrow">Knowledge</p>
      <h2 class="xt-title">Project knowledge</h2>
      <p class="max-w-3xl text-base leading-relaxed text-muted">
        Read durable records from <code>.xtctx/knowledge</code> and pull only the constraints relevant to this task.
      </p>
    </header>

    <section class="xt-card space-y-4">
      <div class="grid gap-3 md:grid-cols-[220px_minmax(0,1fr)_auto_auto] md:items-center">
        <select v-model="type" class="xt-select">
          <option v-for="option in typeOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>

        <input
          v-model="query"
          class="xt-input"
          placeholder="Filter by keyword"
          @keydown.enter.prevent="loadKnowledge"
        />

        <button class="xt-btn" type="button" :disabled="loading" @click="loadKnowledge">
          {{ loading ? "Loading..." : "Apply" }}
        </button>

        <span class="xt-chip-neutral">{{ data.records.length }} records</span>
      </div>

      <div class="flex flex-wrap gap-2">
        <span
          v-for="option in typeOptions.filter((item) => item.value !== 'all')"
          :key="option.value"
          class="xt-chip-neutral"
        >
          {{ option.label }}: {{ typeCounts.get(option.value) ?? 0 }}
        </span>
      </div>
    </section>

    <div v-if="error" class="xt-alert-danger">{{ error }}</div>

    <section v-if="data.records.length > 0" class="space-y-4">
      <article v-for="record in data.records" :key="record.id" class="xt-card space-y-3">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <h3 class="text-lg font-semibold">{{ record.title }}</h3>
          <span :class="typeBadge(record.type)">{{ record.type }}</span>
        </div>

        <p class="text-sm text-muted">{{ record.source_tool }} · {{ new Date(record.created_at).toLocaleString() }}</p>
        <p class="text-base leading-relaxed">{{ record.body }}</p>

        <div class="flex flex-wrap gap-2" v-if="record.domain_tags.length">
          <span v-for="tag in record.domain_tags" :key="`${record.id}-${tag}`" class="xt-chip-neutral">{{ tag }}</span>
        </div>
      </article>
    </section>

    <section v-else class="xt-card space-y-2">
      <h3 class="text-lg font-semibold">No records match this filter.</h3>
      <p class="text-base leading-relaxed text-muted">
        Switch to <code>all</code>, broaden your query, or write back a new decision or FAQ.
      </p>
    </section>
  </section>
</template>
