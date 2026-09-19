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
  A TraceQL trace, in full.

  Structurally the native trace detail — the same header, the same
  Default / Tree / Statistics switch, the same copy affordances — and
  deliberately a SEPARATE component rather than the native one fed converted
  spans. Converting OTLP into SkyWalking's span model is OAP's job, not
  Horizon's; here a span is an OTLP span, and every field on screen is one the
  protocol actually defines.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TraceQLDatasource, TraceQLSpan } from '@skywalking-horizon-ui/api-client';
import TraceQLWaterfall from './TraceQLWaterfall.vue';
import TraceQLTreeView from './TraceQLTreeView.vue';
import TraceQLStatsView from './TraceQLStatsView.vue';
import TraceQLSpanModal from './TraceQLSpanModal.vue';
import { buildServiceColors, fmtDateTime, fmtMs, serviceColorFrom, TRACEQL_POPOUT_QUERY } from './traceqlDetailShared';

const props = defineProps<{
  ds: TraceQLDatasource;
  traceId: string;
  spans: TraceQLSpan[];
  loading?: boolean;
}>();
const emit = defineEmits<{ (e: 'close'): void }>();
const { t } = useI18n({ useScope: 'global' });

type ViewMode = 'default' | 'tree' | 'statistics';
const viewMode = ref<ViewMode>('default');
const selected = ref<TraceQLSpan | null>(null);

// Keeping the picked span would show the previous trace's span under this
// trace's id.
watch(
  () => props.traceId,
  () => {
    selected.value = null;
    viewMode.value = 'default';
  },
);

const services = computed(() => [...buildServiceColors(props.spans).keys()]);
const colors = computed(() => buildServiceColors(props.spans));
const startedUs = computed(() => (props.spans.length ? Math.min(...props.spans.map((s) => s.startUs)) : 0));
const durationUs = computed(() => {
  if (props.spans.length === 0) return 0;
  return Math.max(...props.spans.map((s) => s.startUs + s.durationUs)) - startedUs.value;
});

/** Copy the id, and a URL that reopens this trace on THIS store — the two
 *  TraceQL rows are different pages over different stores, so a link without
 *  the datasource would reopen the id against whichever one the recipient
 *  happened to be on. */
const copyFlash = ref<'id' | 'url' | null>(null);
let copyFlashTimer: ReturnType<typeof setTimeout> | null = null;
function flashCopy(kind: 'id' | 'url'): void {
  copyFlash.value = kind;
  if (copyFlashTimer) clearTimeout(copyFlashTimer);
  copyFlashTimer = setTimeout(() => { copyFlash.value = null; }, 1400);
}
function copyTraceId(): void {
  navigator.clipboard?.writeText(props.traceId).then(() => flashCopy('id'), () => {});
}
function copyShareableUrl(): void {
  const url = new URL(globalThis.location.href);
  // The REAL id, the one every other surface shows — never the hex wire form.
  url.searchParams.set(TRACEQL_POPOUT_QUERY, props.traceId);
  url.searchParams.set('ds', props.ds);
  navigator.clipboard?.writeText(url.toString()).then(() => flashCopy('url'), () => {});
}
onBeforeUnmount(() => { if (copyFlashTimer) clearTimeout(copyFlashTimer); });
</script>

<template>
  <article class="tqc sw-card">
    <header class="tqc-head">
      <span class="tqc-label">{{ t('trace') }}</span>
      <h3 class="mono">{{ traceId }}</h3>
      <button class="sw-btn small ghost" type="button" :title="t('Copy trace id')" @click="copyTraceId">⧉ {{ t('id') }}</button>
      <button class="sw-btn small ghost" type="button" :title="t('Copy shareable URL')" @click="copyShareableUrl">⧉ {{ t('url') }}</button>
      <transition name="copy-flash">
        <span v-if="copyFlash" class="copy-chip">{{ copyFlash === 'url' ? t('url copied') : t('id copied') }}</span>
      </transition>
      <div class="view-toggle">
        <button :class="['vt-btn', { on: viewMode === 'default' }]" type="button" @click="viewMode = 'default'">{{ t('Default') }}</button>
        <button :class="['vt-btn', { on: viewMode === 'tree' }]" type="button" @click="viewMode = 'tree'">{{ t('Tree') }}</button>
        <button :class="['vt-btn', { on: viewMode === 'statistics' }]" type="button" @click="viewMode = 'statistics'">{{ t('Statistics') }}</button>
      </div>
      <button type="button" class="sw-btn small ghost" :aria-label="t('Close')" @click="emit('close')">×</button>
    </header>

    <div class="tqc-stats">
      <div><span class="k">{{ t('STARTED') }}</span><span class="v mono">{{ fmtDateTime(startedUs) }}</span></div>
      <div><span class="k">{{ t('DURATION') }}</span><span class="v mono">{{ fmtMs(durationUs) }}</span></div>
      <div><span class="k">{{ t('SPANS') }}</span><span class="v mono">{{ spans.length }}</span></div>
      <div><span class="k">{{ t('SERVICES') }}</span><span class="v mono">{{ services.length }}</span></div>
    </div>

    <div class="tqc-legend">
      <span v-for="svc in services" :key="svc" class="lg">
        <span class="dot" :style="{ background: serviceColorFrom(colors, svc) }" />{{ svc || '—' }}
      </span>
    </div>

    <p v-if="loading" class="tqc-note">{{ t('Reading data…') }}</p>
    <TraceQLWaterfall
      v-else-if="viewMode === 'default'"
      :spans="spans"
      :selected-span="selected"
      @select-span="selected = $event"
    />
    <TraceQLTreeView
      v-else-if="viewMode === 'tree'"
      :spans="spans"
      :selected-span="selected"
      @select-span="selected = $event"
    />
    <TraceQLStatsView v-else :spans="spans" />

    <TraceQLSpanModal v-if="selected" :span="selected" :trace-id="traceId" @close="selected = null" />
  </article>
</template>

<style scoped>
/* The same ceiling the trace list beside it uses, so a long trace ends on the
   same line as the rail instead of stopping 40px short. */
.tqc { padding: 0; display: flex; flex-direction: column; min-width: 0; max-height: calc(100vh - 80px); overflow: auto; }
.tqc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--sw-line-1);
  flex-wrap: wrap;
}
.tqc-label { font-size: 12px; font-weight: 500; color: var(--sw-fg-3); }
.tqc-head h3 { margin: 0; font-size: 12px; font-weight: 400; color: var(--sw-fg-1); overflow-wrap: anywhere; }
.copy-chip { font-size: 10px; color: var(--sw-accent); border: 1px solid var(--sw-accent); border-radius: 3px; padding: 0 5px; }
.copy-flash-enter-active, .copy-flash-leave-active { transition: opacity 0.2s; }
.copy-flash-enter-from, .copy-flash-leave-to { opacity: 0; }
.view-toggle { margin-left: auto; display: inline-flex; border: 1px solid var(--sw-line-2); border-radius: 5px; overflow: hidden; }
.vt-btn {
  background: var(--sw-bg-2);
  color: var(--sw-fg-2);
  border: none;
  height: 24px;
  padding: 0 10px;
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.vt-btn + .vt-btn { border-left: 1px solid var(--sw-line-2); }
.vt-btn.on { background: var(--sw-accent); color: #fff; }
.tqc-stats { display: flex; gap: 26px; padding: 8px 12px 4px; }
.tqc-stats .k { display: block; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--sw-fg-3); }
.tqc-stats .v { display: block; font-size: 14px; line-height: 1.45; font-weight: 700; color: var(--sw-fg-0); }
.tqc-legend { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 12px 8px; }
.tqc-legend .lg {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10.5px;
  font-family: var(--sw-sans);
  color: var(--sw-fg-2);
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 10px;
  padding: 1px 6px 1px 4px;
}
.tqc-legend .dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; flex: 0 0 auto; }
.tqc-note { padding: 16px 12px; font-size: 11.5px; color: var(--sw-fg-3); }
.mono { font-family: var(--sw-mono); }
</style>
