<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import Button from "primevue/button";
import Card from "primevue/card";
import Message from "primevue/message";
import Tag from "primevue/tag";
import { apiGet } from "../composables/useApi";
import type {
  ContinuityToolsStatusResponse,
  ContinuityWarningsResponse,
  SourceStatusResponse,
  SourcesResponse,
} from "../types";

const loading = ref(true);
const error = ref("");
const sourcesStatus = ref<SourceStatusResponse | null>(null);
const sources = ref<SourcesResponse | null>(null);
const continuity = ref<ContinuityToolsStatusResponse | null>(null);
const warnings = ref<ContinuityWarningsResponse | null>(null);

const inSyncTools = computed(
  () => continuity.value?.tools.filter((tool) => tool.state === "in_sync" && tool.enabled).length ?? 0,
);

const connectedSources = computed(() => sourcesStatus.value?.connectedSources ?? 0);
const indexedRecords = computed(() => sourcesStatus.value?.knowledgeRecords ?? 0);
const sessionsCount = computed(() => sources.value?.sessions.length ?? 0);
const warningCount = computed(() => warnings.value?.count ?? 0);

const readinessSeverity = computed(() => {
  if (!sourcesStatus.value || !continuity.value) {
    return "warn" as const;
  }

  if (warningCount.value > 0) {
    return "warn" as const;
  }

  return sourcesStatus.value.toolPortabilityReady ? "success" as const : "warn" as const;
});

const readinessMessage = computed(() => {
  if (!sourcesStatus.value || !continuity.value) {
    return "Loading continuity posture...";
  }

  if (warningCount.value > 0) {
    return `Continuity warnings detected (${warningCount.value}). Open Tools to reconcile drift.`;
  }

  if (!sourcesStatus.value.toolPortabilityReady) {
    return "No tool history sources are detected yet. Validate scraper paths before relying on handoff recall.";
  }

  return "Continuity posture is healthy. Start with recall, then write back validated outcomes.";
});

onMounted(async () => {
  loading.value = true;
  const [statusPayload, sourcePayload, continuityPayload, warningsPayload] = await Promise.allSettled([
    apiGet<SourceStatusResponse>("/api/sources/status"),
    apiGet<SourcesResponse>("/api/sources"),
    apiGet<ContinuityToolsStatusResponse>("/api/continuity/tools-status"),
    apiGet<ContinuityWarningsResponse>("/api/continuity/warnings"),
  ]);

  if (statusPayload.status === "fulfilled") {
    sourcesStatus.value = statusPayload.value;
  }

  if (sourcePayload.status === "fulfilled") {
    sources.value = sourcePayload.value;
  }

  if (continuityPayload.status === "fulfilled") {
    continuity.value = continuityPayload.value;
  } else {
    error.value = "Tool sync service is unavailable. Check .xtctx/tool-config/shared.yaml.";
  }

  if (warningsPayload.status === "fulfilled") {
    warnings.value = warningsPayload.value;
  }

  loading.value = false;
});

function toolSeverity(state: string) {
  if (state === "in_sync") {
    return "success";
  }

  if (state === "disabled_by_policy") {
    return "secondary";
  }

  if (state === "missing_target") {
    return "warn";
  }

  return "danger";
}
</script>

<template>
  <section class="page-shell">
    <div class="page-head">
      <p class="page-eyebrow">Continuity posture</p>
      <h2>Dashboard</h2>
      <p>
        Run the same workflow every session: verify tool sync posture, recall context,
        implement with constraints in scope, then write back.
      </p>
    </div>

    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
    <Message v-else :severity="readinessSeverity" :closable="false">{{ readinessMessage }}</Message>

    <div class="kpi-grid">
      <Card class="surface-card kpi-card">
        <template #content>
          <p class="kpi-value">{{ connectedSources }}</p>
          <p class="kpi-label">Connected sources</p>
        </template>
      </Card>
      <Card class="surface-card kpi-card">
        <template #content>
          <p class="kpi-value">{{ indexedRecords }}</p>
          <p class="kpi-label">Indexed records</p>
        </template>
      </Card>
      <Card class="surface-card kpi-card">
        <template #content>
          <p class="kpi-value">{{ inSyncTools }}</p>
          <p class="kpi-label">In-sync tools</p>
        </template>
      </Card>
      <Card class="surface-card kpi-card">
        <template #content>
          <p class="kpi-value">{{ sessionsCount }}</p>
          <p class="kpi-label">Recent sessions</p>
        </template>
      </Card>
    </div>

    <Card class="surface-card">
      <template #title>Tool sync strip</template>
      <template #content>
        <div class="chip-row">
          <Tag
            v-for="tool in continuity?.tools ?? []"
            :key="tool.tool"
            :severity="toolSeverity(tool.state)"
            :value="`${tool.tool}: ${tool.state.replace(/_/g, ' ')}`"
          />
        </div>
      </template>
    </Card>

    <div class="dashboard-grid">
      <Card class="surface-card">
        <template #title>Session starter</template>
        <template #content>
          <ol class="flow-list">
            <li>Run <code>xtctx_search</code> for the active task or failure signature.</li>
            <li>Open <code>xtctx_project_knowledge</code> with <code>type: all</code>.</li>
            <li>Implement with recovered constraints in scope.</li>
          </ol>
          <div class="chip-row chip-row-top">
            <RouterLink to="/search" custom v-slot="{ navigate }">
              <Button label="Open search" icon="pi pi-search" @click="navigate" />
            </RouterLink>
            <RouterLink to="/knowledge" custom v-slot="{ navigate }">
              <Button label="Open knowledge" icon="pi pi-book" outlined @click="navigate" />
            </RouterLink>
          </div>
        </template>
      </Card>

      <Card class="surface-card">
        <template #title>Writeback targets</template>
        <template #content>
          <p class="helper-copy">
            Capture validated outcomes so the next assistant session can resume without re-briefing.
          </p>
          <div class="chip-row chip-row-top">
            <Tag severity="success" value="xtctx_save_decision" />
            <Tag severity="danger" value="xtctx_save_error_solution" />
            <Tag severity="info" value="xtctx_save_faq" />
          </div>
        </template>
      </Card>
    </div>

    <Card class="surface-card" v-if="!loading && (warnings?.warnings.length ?? 0) > 0">
      <template #title>Drift and warning queue</template>
      <template #content>
        <ul class="warning-list">
          <li v-for="entry in warnings?.warnings ?? []" :key="`${entry.tool}-${entry.warning}`">
            <strong>{{ entry.tool }}</strong>: {{ entry.warning }}
          </li>
        </ul>
      </template>
    </Card>
  </section>
</template>
