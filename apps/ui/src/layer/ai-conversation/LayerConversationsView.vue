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
  The Conversations tab of an AI_AGENT layer: the conversations of one agent
  runtime (the shell's picked service) in a window, one row each, newest
  activity first. Like the Traces and Logs tabs it owns its time range and
  fires on Run query; the sender, the title text and the conversation id are
  query conditions OAP applies. A row opens the conversation in a new tab.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { AiConversationRow, LayerDef } from '@/api/client';
import { useLayers } from '@/shell/useLayers';
import { useSetupStore } from '@/state/setup';
import { useLayerLanding } from '@/layer/useLayerLanding';
import { useLayerInstances } from '@/layer/useLayerInstances';
import { useLayerTabService } from '@/layer/useLayerServiceName';
import { useSelectedService } from '@/layer/useSelectedService';
import { useLayerConversations } from '@/layer/ai-conversation/useLayerConversations';
import { formatDuration, timestampLabel } from '@/utils/formatters';

const route = useRoute();
const router = useRouter();
const { t } = useI18n({ useScope: 'global' });
const layerKey = computed(() => String(route.params.layerKey ?? ''));

const { layers } = useLayers();
const layer = computed<LayerDef | null>(() => layers.value.find((l) => l.key === layerKey.value) ?? null);
const senderLabel = computed(() => layer.value?.slots.instances ?? t('Sender'));

// The runtime is the shell's picked service, resolved to the NAME the OAP
// list keys on — sample first, then the full roster, as the other tabs do.
const { selectedId, setSelected: setSelectedService } = useSelectedService();
const store = useSetupStore();
const safeLayer = computed<LayerDef>(() => layer.value ?? {
  key: layerKey.value, name: layerKey.value, color: 'var(--sw-fg-2)',
  serviceCount: -1, active: false, level: null, slots: {}, caps: {},
});
const safeCfg = computed(() => {
  if (!layer.value) return { priority: 99, topN: 5, orderBy: 'cpm', columns: [] };
  return store.ensure(layer.value.key, {
    slots: layer.value.slots, caps: layer.value.caps, metrics: layer.value.metrics,
  }).landing;
});
const landing = useLayerLanding(safeLayer, safeCfg);
const {
  name: serviceName,
  ref: serviceRef,
  status: serviceStatus,
  ready: serviceReady,
} = useLayerTabService(layerKey, landing, {
  embedded: computed(() => false),
  focusService: computed(() => null),
  focusServiceId: computed(() => null),
});
const serviceKey = computed<string | null>(() => serviceRef.value?.id ?? null);
const landingRows = computed(() => landing.data.value?.sampledRows ?? landing.rows.value ?? []);
watch(
  landingRows,
  (rows) => {
    if (selectedId.value) return;
    const first = rows[0];
    if (first) setSelectedService(first.serviceId);
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

// The senders of this runtime are its instances active in the tab's window —
// a Sessionizer pushes hours apart, so the shell's recent default misses them.
const { instances: senders } = useLayerInstances(layerKey, serviceRef, windowMinutes);
const senderFilter = ref('');

// Manual fire: the picks stage into `applied`, and the query reads that
// snapshot, so it runs on Run query and never on a half-changed toolbar.
const titleFilter = ref('');
const conversationFilter = ref('');
interface Applied {
  service: string | null;
  instanceName: string | null;
  conversation: string | null;
  title: string | null;
  windowMinutes: number;
}
const applied = ref<Applied>({ service: null, instanceName: null, conversation: null, title: null, windowMinutes: windowMinutes.value });
const hasQueried = ref(false);
const queryEnabled = computed(() => hasQueried.value && !!applied.value.service);
const { rows, limit, reachable, queryError, error: transportError, isFetching, refetch } = useLayerConversations(layerKey, {
  service: computed(() => applied.value.service),
  instanceName: computed(() => applied.value.instanceName),
  conversation: computed(() => applied.value.conversation),
  title: computed(() => applied.value.title),
  windowMinutes: computed(() => applied.value.windowMinutes),
  enabled: queryEnabled,
});
function runQuery(): void {
  if (!serviceReady.value || !serviceName.value) return;
  applied.value = {
    service: serviceName.value,
    instanceName: senderFilter.value || null,
    conversation: conversationFilter.value.trim() || null,
    title: titleFilter.value.trim() || null,
    windowMinutes: windowMinutes.value,
  };
  hasQueried.value = true;
  void refetch();
}

// A runtime switch is a context change: back to the Run-query prompt, every
// condition cleared, so the previous runtime's rows never sit under the new name.
watch(serviceKey, () => {
  hasQueried.value = false;
  senderFilter.value = '';
  titleFilter.value = '';
  conversationFilter.value = '';
});

const transportErrorText = computed(() =>
  transportError.value instanceof Error ? transportError.value.message : transportError.value ? String(transportError.value) : '',
);

function spanOf(r: AiConversationRow): string {
  return formatDuration(Math.max(0, r.to - r.from) / 1000, true);
}

// A conversation opens in its own tab: the document is tens of megabytes and
// the reader keeps the list. `noopener` because the new page needs nothing
// from this one; the URL carries the conversation, its runtime and sender.
function openConversation(r: AiConversationRow): void {
  const service = applied.value.service;
  if (!service) return;
  const href = router.resolve({
    name: 'ai-conversation',
    params: { conversation: r.conversation },
    query: { service, instance: r.serviceInstanceName },
  }).href;
  window.open(href, '_blank', 'noopener');
}
</script>

<template>
  <div class="cv-tab">
    <section class="cv-toolbar sw-card">
      <div class="cv-toolbar-head">
        <span class="kicker">{{ t('AI agent conversations') }}</span>
        <span v-if="isFetching" class="hint">{{ t('refreshing…') }}</span>
        <button
          class="sw-btn primary cv-run-btn"
          type="button"
          :disabled="!serviceReady"
          @click="runQuery"
        >{{ t('Run query') }}</button>
      </div>
      <div class="cv-controls">
        <label class="cv-field">
          <span>{{ t('Time range') }}</span>
          <select v-model.number="windowMinutes">
            <option v-for="p in WINDOW_PRESETS" :key="p.minutes" :value="p.minutes">{{ p.label }}</option>
          </select>
        </label>
        <label class="cv-field">
          <span>{{ senderLabel }}</span>
          <select v-model="senderFilter" :disabled="!serviceReady">
            <option value="">{{ t('All') }}</option>
            <option v-for="s in senders" :key="s.id" :value="s.name">{{ s.name }}</option>
          </select>
        </label>
        <label class="cv-field cv-grow">
          <span>{{ t('Title contains') }}</span>
          <input v-model="titleFilter" type="search" :disabled="!serviceReady" @keydown.enter.prevent="runQuery" />
        </label>
        <label class="cv-field cv-grow">
          <span>{{ t('Conversation id') }}</span>
          <input v-model="conversationFilter" type="search" class="cv-mono" :disabled="!serviceReady" @keydown.enter.prevent="runQuery" />
        </label>
      </div>
    </section>

    <section class="cv-body sw-card">
      <div v-if="!serviceReady" class="cv-empty">
        <template v-if="serviceStatus === 'resolving'">{{ t('Resolving service…') }}</template>
        <template v-else-if="serviceStatus === 'unknown'">
          {{ t('The selected service is not in this layer — pick another one to query.') }}
        </template>
        <template v-else>{{ t('Pick a service to run this query.') }}</template>
      </div>
      <div v-else-if="!hasQueried" class="cv-empty">
        {{ t('Pick a time range, then click Run query.') }}
      </div>
      <div v-else-if="isFetching" class="cv-empty">{{ t('Reading data…') }}</div>
      <div v-else-if="transportError || !reachable" class="banner err">
        {{ t('The conversation list could not be read.') }}
        <code v-if="transportError">{{ transportErrorText }}</code>
        <code v-else-if="queryError">{{ queryError }}</code>
      </div>
      <template v-else>
        <div v-if="queryError" class="banner err">
          {{ t('OAP answered with an error; the rows below may be incomplete.') }}
          <code>{{ queryError }}</code>
        </div>
        <div class="cv-meta">
          <span class="cv-count">{{ t('{n} conversations', { n: rows.length }) }}</span>
          <span v-if="limit" class="cv-rule">
            {{ t('Listed from the newest {n} rounds in the window; a conversation whose newest round is older than that is not shown.', { n: limit }) }}
          </span>
        </div>
        <div v-if="rows.length === 0" class="cv-empty">{{ t('No conversations in this window.') }}</div>
        <div v-else class="cv-table-wrap">
          <table class="cv-table">
            <thead>
              <tr>
                <th class="left">{{ t('Title') }}</th>
                <th class="left">{{ senderLabel }}</th>
                <th>{{ t('Talks') }}</th>
                <th>{{ t('Steps') }}</th>
                <th>{{ t('Streams') }}</th>
                <th>{{ t('Segments (activity windows)') }}</th>
                <th>{{ t('Unresolved') }}</th>
                <th>{{ t('Span (elapsed)') }}</th>
                <th class="left">{{ t('Last activity') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in rows"
                :key="`${r.serviceInstanceId}/${r.conversation}`"
                class="cv-row"
                tabindex="0"
                :title="t('Open the conversation in a new tab')"
                @click="openConversation(r)"
                @keydown.enter.prevent="openConversation(r)"
              >
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
.cv-toolbar { padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }
.cv-toolbar-head { display: flex; align-items: center; gap: 10px; width: 100%; }
.cv-toolbar-head .hint { color: var(--sw-fg-2); font-size: var(--sw-fs-xs); }
/* `.sw-btn.primary` is locally scoped per page (each view declares its own);
   the rule is copied to keep the visual stable without a shared global. */
.cv-run-btn { margin-left: auto; }
.sw-btn.primary {
  background: var(--sw-accent);
  color: var(--sw-bg-0);
  border: none;
  height: 26px;
  padding: 0 14px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.sw-btn.primary:hover { background: var(--sw-accent-2); }
.sw-btn.primary:disabled { opacity: 0.5; cursor: default; }
.cv-controls { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: flex-end; }
.cv-field { display: flex; flex-direction: column; gap: 3px; min-width: 160px; }
.cv-field > span { color: var(--sw-fg-2); font-size: var(--sw-fs-xs); text-transform: uppercase; letter-spacing: 0.06em; }
.cv-field select,
.cv-field input {
  min-height: 26px;
  padding: 2px 8px;
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-0);
  font-size: var(--sw-fs-sm);
}
.cv-grow { flex: 1; min-width: 240px; }
.cv-body { padding: 0; overflow: hidden; }
.cv-empty { padding: 28px 12px; color: var(--sw-fg-2); font-size: var(--sw-fs-sm); text-align: center; }
.banner.err { margin: 10px; padding: 8px 10px; border: 1px solid color-mix(in srgb, var(--sw-err) 45%, transparent); border-radius: 4px; color: var(--sw-fg-1); font-size: var(--sw-fs-sm); }
.banner.err code { display: block; margin-top: 4px; color: var(--sw-fg-2); font-size: var(--sw-fs-xs); }
.cv-meta { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; padding: 8px 10px; border-bottom: 1px solid var(--sw-line); font-size: var(--sw-fs-xs); color: var(--sw-fg-2); }
.cv-count { color: var(--sw-fg-0); font-weight: 600; }
.cv-table-wrap { overflow-x: auto; }
.cv-table { width: 100%; border-collapse: collapse; font-size: var(--sw-fs-sm); }
.cv-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 6px 10px;
  border-bottom: 1px solid var(--sw-line-2);
  background: var(--sw-bg-2);
  color: var(--sw-fg-2);
  font-size: var(--sw-fs-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-align: right;
  text-transform: uppercase;
  white-space: nowrap;
}
.cv-table td { padding: 6px 10px; border-bottom: 1px solid var(--sw-line); color: var(--sw-fg-1); text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.cv-table th.left,
.cv-table td.left { text-align: left; }
.cv-table td.left:first-child { white-space: normal; min-width: 260px; }
.cv-table tbody tr.cv-row { cursor: pointer; }
.cv-table tbody tr:hover td,
.cv-table tbody tr:focus-visible td { background: var(--sw-bg-3); }
.cv-table tbody tr:focus-visible { outline: 2px solid var(--sw-accent); outline-offset: -2px; }
.cv-title { display: block; color: var(--sw-fg-0); }
.cv-title.untitled { color: var(--sw-fg-3); font-style: italic; }
.cv-id { display: block; color: var(--sw-fg-3); font-family: var(--sw-mono); font-size: var(--sw-fs-xs); }
.cv-mono { font-family: var(--sw-mono); font-size: var(--sw-fs-xs); }
.cv-warn { color: var(--sw-warn); }
</style>
