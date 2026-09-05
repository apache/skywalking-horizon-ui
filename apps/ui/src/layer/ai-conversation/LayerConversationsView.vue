<!--
  Licensed to the Apache Software Foundation (ASF) under one or more
  contributor license agreements.  See the NOTICE file distributed with
  this work for additional information regarding copyright ownership.
  The ASF licenses this file to You under the Apache License, Version 2.0
  (the "License"); you may not use this file except in compliance with
  the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
-->
<!--
  Per-layer "Conversations" tab (AI_AGENT): the AI agent conversations the AI
  Sessionizer pushed for one agent runtime, one row per conversation.

  The tab owns its pickers. The layer carries no metrics yet, so the shell's
  metric-ranked service picker has nothing to rank by; the runtime is picked
  from the layer's roster by name, and the sender filter is a facet over the
  rows in hand rather than a second OAP read. Like the other record tabs it
  owns its time range and fires on Run query.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { AiConversationRow, LayerDef } from '@/api/client';
import { useLayers } from '@/shell/useLayers';
import { useLayerServices } from '@/layer/useLayerServices';
import { useLayerConversations } from '@/layer/ai-conversation/useLayerConversations';
import { formatDuration, timestampLabel } from '@/utils/formatters';

const route = useRoute();
const { t } = useI18n({ useScope: 'global' });
const layerKey = computed(() => String(route.params.layerKey ?? ''));

const { layers } = useLayers();
const layer = computed<LayerDef | null>(() => layers.value.find((l) => l.key === layerKey.value) ?? null);
const runtimeLabel = computed(() => layer.value?.slots.services ?? t('Agent runtime'));
const senderLabel = computed(() => layer.value?.slots.instances ?? t('Sender'));

// The runtime picker reads the layer's roster, by name: the list is keyed on
// the service NAME, and there is no metric to rank the roster by.
const {
  services,
  isLoading: servicesLoading,
  isError: servicesError,
} = useLayerServices(layerKey, { rideTicker: false });
const serviceName = ref<string | null>(null);
watch(
  services,
  (rows) => {
    if (rows.length === 0) return;
    if (!serviceName.value || !rows.some((r) => r.name === serviceName.value)) {
      serviceName.value = rows[0]!.name;
    }
  },
  { immediate: true },
);

// Own time range. Conversations run for days, so the presets start at a day
// and the default is a week — the BFF caps a window at 90 days.
const WINDOW_PRESETS = computed(() => [
  { label: t('Last 24 hours'), minutes: 24 * 60 },
  { label: t('Last 7 days'), minutes: 7 * 24 * 60 },
  { label: t('Last 30 days'), minutes: 30 * 24 * 60 },
  { label: t('Last 90 days'), minutes: 90 * 24 * 60 },
]);
const windowMinutes = ref<number>(7 * 24 * 60);

// Manual fire: the picks stage into `applied`, and the query reads that
// snapshot, so it runs on Run query and never on a half-changed toolbar.
interface Applied {
  service: string | null;
  windowMinutes: number;
}
const applied = ref<Applied>({ service: null, windowMinutes: windowMinutes.value });
const hasQueried = ref(false);
const queryEnabled = computed(() => hasQueried.value && !!applied.value.service);
const { rows, limit, reachable, queryError, isFetching, refetch } = useLayerConversations(layerKey, {
  service: computed(() => applied.value.service),
  windowMinutes: computed(() => applied.value.windowMinutes),
  enabled: queryEnabled,
});
function runQuery(): void {
  if (!serviceName.value) return;
  applied.value = { service: serviceName.value, windowMinutes: windowMinutes.value };
  hasQueried.value = true;
  void refetch();
}

// Facets over the rows in hand. The sender list is what the rows say, so it
// always matches the table beneath it.
const senderFilter = ref('');
const titleFilter = ref('');
const senders = computed(() =>
  [...new Set(rows.value.map((r) => r.serviceInstanceName))].sort((a, b) => a.localeCompare(b)),
);
const visibleRows = computed<AiConversationRow[]>(() => {
  const needle = titleFilter.value.trim().toLowerCase();
  return rows.value.filter(
    (r) =>
      (!senderFilter.value || r.serviceInstanceName === senderFilter.value) &&
      (!needle || `${r.title} ${r.conversation}`.toLowerCase().includes(needle)),
  );
});

// A runtime switch is a context change: back to the Run-query prompt, facets
// cleared, so the previous runtime's rows never sit under the new name.
watch(serviceName, () => {
  hasQueried.value = false;
  senderFilter.value = '';
  titleFilter.value = '';
});

function spanOf(r: AiConversationRow): string {
  return formatDuration(Math.max(0, r.to - r.from) / 1000, true);
}
</script>

<template>
  <div class="cv-tab">
    <section class="cv-toolbar sw-card">
      <div class="cv-toolbar-head">
        <span class="kicker">{{ t('AI agent conversations') }}</span>
        <button
          class="sw-btn primary"
          type="button"
          :disabled="isFetching || !serviceName"
          @click="runQuery"
        >
          {{ t('Run query') }}
        </button>
      </div>
      <div class="cv-controls">
        <label class="cv-field">
          <span>{{ runtimeLabel }}</span>
          <select v-model="serviceName" :disabled="servicesLoading || services.length === 0">
            <option v-if="services.length === 0" :value="null" disabled>
              {{ servicesLoading ? t('Loading…') : t('No services in this layer') }}
            </option>
            <option v-for="s in services" :key="s.id" :value="s.name">{{ s.name }}</option>
          </select>
        </label>
        <label class="cv-field">
          <span>{{ t('Time range') }}</span>
          <select v-model.number="windowMinutes">
            <option v-for="p in WINDOW_PRESETS" :key="p.minutes" :value="p.minutes">{{ p.label }}</option>
          </select>
        </label>
        <label class="cv-field">
          <span>{{ senderLabel }}</span>
          <select v-model="senderFilter" :disabled="rows.length === 0">
            <option value="">{{ t('All') }}</option>
            <option v-for="s in senders" :key="s" :value="s">{{ s }}</option>
          </select>
        </label>
        <label class="cv-field cv-grow">
          <span>{{ t('Filter') }}</span>
          <input
            v-model="titleFilter"
            type="search"
            :placeholder="t('Filter by title or conversation id')"
            :disabled="rows.length === 0"
          />
        </label>
      </div>
    </section>

    <section class="cv-body sw-card">
      <div v-if="servicesError" class="banner err">{{ t('The service list could not be read.') }}</div>
      <div v-else-if="!hasQueried" class="cv-empty">
        {{ t('Pick an agent runtime and a time range, then click Run query.') }}
      </div>
      <div v-else-if="isFetching" class="cv-empty">{{ t('Reading data…') }}</div>
      <div v-else-if="!reachable" class="banner err">
        {{ t('The conversation list could not be read.') }}
        <code v-if="queryError">{{ queryError }}</code>
      </div>
      <template v-else>
        <div class="cv-meta">
          <span class="cv-count">{{ t('{n} conversations', { n: visibleRows.length }) }}</span>
          <span v-if="queryError" class="cv-warn">{{ queryError }}</span>
          <span v-if="limit" class="cv-rule">
            {{ t('Listed from the newest {n} rounds in the window; a conversation whose newest round is older than that is not shown.', { n: limit }) }}
          </span>
        </div>
        <div v-if="visibleRows.length === 0" class="cv-empty">{{ t('No conversations in this window.') }}</div>
        <div v-else class="cv-table-wrap">
          <table class="cv-table">
            <thead>
              <tr>
                <th class="left">{{ t('Title') }}</th>
                <th class="left">{{ senderLabel }}</th>
                <th>{{ t('Talks') }}</th>
                <th>{{ t('Steps') }}</th>
                <th>{{ t('Streams') }}</th>
                <th>{{ t('Segments') }}</th>
                <th>{{ t('Unresolved') }}</th>
                <th>{{ t('Span') }}</th>
                <th class="left">{{ t('Last activity') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in visibleRows" :key="`${r.serviceInstanceId}/${r.conversation}`">
                <td class="left">
                  <span class="cv-title" :class="{ untitled: !r.title }">{{ r.title || t('(untitled)') }}</span>
                  <span class="cv-id">{{ r.conversation }}</span>
                </td>
                <td class="left cv-mono">{{ r.serviceInstanceName }}</td>
                <td>{{ r.talks }}</td>
                <td>{{ r.steps }}</td>
                <td>{{ r.streams }}</td>
                <td>{{ r.segments }}</td>
                <td :class="{ 'cv-warn': r.unresolved > 0 }">{{ r.unresolved }}</td>
                <td>{{ spanOf(r) }}</td>
                <td class="left">{{ timestampLabel(r.to) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.cv-tab { display: flex; flex-direction: column; gap: 8px; }
.cv-toolbar { padding: 8px 10px; }
.cv-toolbar-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.cv-controls { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: flex-end; }
.cv-field { display: flex; flex-direction: column; gap: 3px; min-width: 160px; }
.cv-field > span { color: var(--sw-fg-2); font-size: var(--sw-fs-xs); text-transform: uppercase; letter-spacing: 0.06em; }
.cv-field select,
.cv-field input {
  min-height: 26px;
  padding: 2px 8px;
  border: 1px solid var(--sw-line-2);
  border-radius: var(--sw-radius);
  background: var(--sw-bg-1);
  color: var(--sw-fg-0);
  font-size: var(--sw-fs-sm);
}
.cv-grow { flex: 1 1 220px; }
.cv-body { padding: 0; overflow: hidden; }
.cv-empty { padding: 28px 12px; color: var(--sw-fg-2); font-size: var(--sw-fs-sm); text-align: center; }
.cv-meta { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: baseline; padding: 8px 10px; border-bottom: 1px solid var(--sw-line); font-size: var(--sw-fs-xs); color: var(--sw-fg-2); }
.cv-count { color: var(--sw-fg-1); font-weight: var(--sw-fw-medium); }
.cv-rule { color: var(--sw-fg-3); }
.cv-warn { color: var(--sw-warn); }
.cv-table-wrap { overflow-x: auto; }
.cv-table { width: 100%; border-collapse: collapse; font-size: var(--sw-fs-sm); }
.cv-table th {
  position: sticky;
  top: 0;
  padding: 6px 10px;
  border-bottom: 1px solid var(--sw-line);
  background: var(--sw-bg-2);
  color: var(--sw-fg-2);
  font-size: var(--sw-fs-xs);
  font-weight: var(--sw-fw-medium);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  text-align: right;
  white-space: nowrap;
}
.cv-table td { padding: 6px 10px; border-bottom: 1px solid var(--sw-line); color: var(--sw-fg-1); text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.cv-table th.left,
.cv-table td.left { text-align: left; }
.cv-table td.left:first-child { white-space: normal; min-width: 260px; }
.cv-table tbody tr:hover td { background: var(--sw-bg-3); }
.cv-title { display: block; color: var(--sw-fg-0); font-weight: var(--sw-fw-medium); }
.cv-title.untitled { color: var(--sw-fg-3); font-weight: var(--sw-fw-regular); }
.cv-id { display: block; margin-top: 2px; color: var(--sw-fg-3); font-family: var(--sw-mono); font-size: var(--sw-fs-xs); }
.cv-mono { font-family: var(--sw-mono); font-size: var(--sw-fs-xs); }
.cv-body code { font-family: var(--sw-mono); font-size: var(--sw-fs-xs); }
</style>
