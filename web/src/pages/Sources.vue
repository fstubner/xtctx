<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import Card from "primevue/card";
import Column from "primevue/column";
import DataTable from "primevue/datatable";
import Message from "primevue/message";
import Tag from "primevue/tag";
import { apiGet } from "../composables/useApi";
import type { SourceStatusResponse, SourcesResponse } from "../types";

const loading = ref(true);
const error = ref("");
const status = ref<SourceStatusResponse | null>(null);
const sources = ref<SourcesResponse | null>(null);

const detectedCount = computed(
  () => status.value?.scrapers.filter((scraper) => scraper.enabled && scraper.detected).length ?? 0,
);

const enabledCount = computed(
  () => status.value?.scrapers.filter((scraper) => scraper.enabled).length ?? 0,
);

onMounted(async () => {
  try {
    loading.value = true;
    const [statusPayload, sourcesPayload] = await Promise.all([
      apiGet<SourceStatusResponse>("/api/sources/status"),
      apiGet<SourcesResponse>("/api/sources"),
    ]);

    status.value = statusPayload;
    sources.value = sourcesPayload;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section class="page-shell">
    <div class="page-head">
      <p class="page-eyebrow">Ingestion coverage</p>
      <h2>Sources</h2>
      <p>
        Confirm which tool histories are detected and whether session continuity is actually ingesting.
      </p>
    </div>

    <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>

    <div class="kpi-grid">
      <Card class="surface-card kpi-card">
        <template #content>
          <p class="kpi-value">{{ enabledCount }}</p>
          <p class="kpi-label">Enabled scrapers</p>
        </template>
      </Card>
      <Card class="surface-card kpi-card">
        <template #content>
          <p class="kpi-value">{{ detectedCount }}</p>
          <p class="kpi-label">Detected sources</p>
        </template>
      </Card>
      <Card class="surface-card kpi-card">
        <template #content>
          <p class="kpi-value">{{ status?.knowledgeRecords ?? 0 }}</p>
          <p class="kpi-label">Indexed records</p>
        </template>
      </Card>
      <Card class="surface-card kpi-card">
        <template #content>
          <p class="kpi-value">{{ sources?.sessions.length ?? 0 }}</p>
          <p class="kpi-label">Recent sessions</p>
        </template>
      </Card>
    </div>

    <div class="split-grid">
      <Card class="surface-card">
        <template #title>Scraper health</template>
        <template #content>
          <DataTable
            :value="status?.scrapers ?? []"
            stripedRows
            responsiveLayout="scroll"
            :loading="loading"
          >
            <Column field="tool" header="Tool" />
            <Column field="enabled" header="Enabled">
              <template #body="{ data }">
                <Tag :severity="data.enabled ? 'info' : 'secondary'" :value="data.enabled ? 'yes' : 'no'" />
              </template>
            </Column>
            <Column field="detected" header="Detected">
              <template #body="{ data }">
                <Tag :severity="data.detected ? 'success' : 'warn'" :value="data.detected ? 'yes' : 'no'" />
              </template>
            </Column>
            <Column field="path" header="Path">
              <template #body="{ data }">
                <code>{{ data.path }}</code>
              </template>
            </Column>
          </DataTable>
        </template>
      </Card>

      <Card class="surface-card">
        <template #title>Recent sessions</template>
        <template #content>
          <DataTable
            :value="sources?.sessions ?? []"
            stripedRows
            responsiveLayout="scroll"
            :loading="loading"
          >
            <Column field="session_ref" header="Session" />
            <Column field="tool" header="Tool" />
            <Column field="started_at" header="Started">
              <template #body="{ data }">
                {{ new Date(data.started_at).toLocaleString() }}
              </template>
            </Column>
            <Column field="message_count" header="Msgs" />
          </DataTable>
        </template>
      </Card>
    </div>
  </section>
</template>
