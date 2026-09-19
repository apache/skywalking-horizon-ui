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
  The layer's trace stores: which trace APIs it exposes, what each row is
  called, and — for the TraceQL rows — which services its picker offers.

  A checklist, not a picker: a layer can expose any combination, and each
  checked store becomes its own sidebar row.

  What is ticked when the page opens is what the layer RESOLVES to, not what its
  template literally says — a template written before the checklist carries the
  legacy `source` enum, or says nothing at all and falls back to the native
  store. Showing that is what lets the operator change one box and save: the
  first edit writes the resolved set out as an explicit `sources`, which then
  overrides the fallback.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  backtracksBadly,
  TRACE_STORES,
  TRACE_STORE_ROWS,
  resolveTraceStores,
  type TraceStore,
  type TraceStoreConfig,
  type TracesConfig,
} from '@skywalking-horizon-ui/api-client';

const props = defineProps<{ traces?: TracesConfig; readOnly?: boolean }>();
const emit = defineEmits<{ (e: 'update', value: TracesConfig | undefined): void }>();
const { t } = useI18n({ useScope: 'global' });

/** The TraceQL stores are the two that answer over Tempo's API, and the only
 *  ones a service filter applies to — the others know their layer already. */
const TRACEQL_STORES = new Set<TraceStore>(['traceql-native', 'traceql-zipkin']);

const STORE_ROWS = computed(() =>
  TRACE_STORES.map((store) => ({
    store,
    path: TRACE_STORE_ROWS[store],
    label: defaultName(store),
    hint: hintFor(store),
    traceql: TRACEQL_STORES.has(store),
  })),
);

function defaultName(store: TraceStore): string {
  switch (store) {
    case 'native': return t('Traces');
    case 'zipkin': return t('Zipkin Traces');
    case 'traceql-native': return t('TraceQL - Native');
    case 'traceql-zipkin': return t('TraceQL - Zipkin');
  }
}

function hintFor(store: TraceStore): string {
  switch (store) {
    case 'native': return t("SkyWalking's own trace query.");
    case 'zipkin': return t('OAP’s Zipkin v2 API, which also serves the OpenTelemetry spans OAP converts into Zipkin form.');
    case 'traceql-native': return t('Grafana Tempo’s API over the native spans. Needs OAP’s traceQL module and a configured datasource URL.');
    case 'traceql-zipkin': return t('Grafana Tempo’s API over the Zipkin spans. Needs OAP’s traceQL module and a configured datasource URL.');
  }
}

const checked = computed(() => new Set(resolveTraceStores(props.traces)));

/** Every write goes through here, so the stored block never keeps settings for
 *  a store the layer no longer exposes — configuration nobody can see is
 *  configuration nobody remembers writing. Both fallbacks are resolved away on
 *  the first edit: what was implied becomes an explicit `sources`, and the
 *  legacy `source` enum is not written back. */
function commit(sources: TraceStore[], stores: Partial<Record<TraceStore, TraceStoreConfig>>): void {
  const kept: Partial<Record<TraceStore, TraceStoreConfig>> = {};
  for (const s of sources) {
    const cfg = stores[s];
    if (cfg && (cfg.name || cfg.serviceFilter?.pattern)) kept[s] = cfg;
  }
  // An empty LIST, never an absent block: a template that says nothing about
  // traces resolves to the native store for compatibility, so removing the
  // block would tick native back on rather than turn everything off.
  if (sources.length === 0 && Object.keys(kept).length === 0) {
    emit('update', { sources: [] });
    return;
  }
  emit('update', Object.keys(kept).length > 0 ? { sources, stores: kept } : { sources });
}

function currentStores(): Partial<Record<TraceStore, TraceStoreConfig>> {
  return { ...(props.traces?.stores ?? {}) };
}

function toggle(store: TraceStore): void {
  if (props.readOnly) return;
  const next = TRACE_STORES.filter((s) => (s === store ? !checked.value.has(s) : checked.value.has(s)));
  commit(next, currentStores());
}

function setName(store: TraceStore, name: string): void {
  if (props.readOnly) return;
  const stores = currentStores();
  const cfg = { ...(stores[store] ?? {}) };
  if (name.trim()) cfg.name = name;
  else delete cfg.name;
  stores[store] = cfg;
  commit([...checked.value], stores);
}

function setFilter(store: TraceStore, part: 'pattern' | 'flags', value: string): void {
  if (props.readOnly) return;
  const stores = currentStores();
  const cfg = { ...(stores[store] ?? {}) };
  const filter = { ...(cfg.serviceFilter ?? { pattern: '' }), [part]: value };
  if (filter.pattern.trim()) cfg.serviceFilter = filter;
  else delete cfg.serviceFilter;
  stores[store] = cfg;
  commit([...checked.value], stores);
}

/** The only regular-expression flag worth offering for a service name. The
 *  others are meaningless on one line (`m`, `s`) or change what the pattern
 *  matches under the operator (`g`, `y` carry state between tests). */
function ignoresCase(store: TraceStore): boolean {
  return (filterOf(store).flags ?? '').includes('i');
}
function setIgnoreCase(store: TraceStore, on: boolean): void {
  setFilter(store, 'flags', on ? 'i' : '');
}

function nameOf(store: TraceStore): string {
  return props.traces?.stores?.[store]?.name ?? '';
}
function filterOf(store: TraceStore): { pattern: string; flags?: string } {
  return props.traces?.stores?.[store]?.serviceFilter ?? { pattern: '' };
}
/** A pattern Horizon will not run filters NOTHING rather than emptying the
 *  picker, so the operator is told here rather than left wondering — whether it
 *  does not compile or is refused for backtracking. */
function filterInvalid(store: TraceStore): boolean {
  const f = filterOf(store);
  if (!f.pattern.trim()) return false;
  if (backtracksBadly(f.pattern)) return true;
  try {
    new RegExp(f.pattern, f.flags ?? '');
    return false;
  } catch {
    return true;
  }
}
</script>

<template>
  <div class="ts-list">
    <div v-for="row in STORE_ROWS" :key="row.store" class="ts-item" :class="{ on: checked.has(row.store) }">
      <label class="ts-head">
        <input
          type="checkbox"
          :checked="checked.has(row.store)"
          :disabled="readOnly"
          @change="toggle(row.store)"
        />
        <span class="ts-name">{{ row.label }}</span>
        <code class="ts-path">{{ row.path }}</code>
      </label>
      <p class="ts-hint">{{ row.hint }}</p>
      <div v-if="checked.has(row.store)" class="ts-fields">
        <label class="ts-field">
          <span>{{ t('Menu name') }}</span>
          <input
            type="text"
            class="alias-input sm"
            :value="nameOf(row.store)"
            :placeholder="row.label"
            :disabled="readOnly"
            spellcheck="false"
            @input="setName(row.store, ($event.target as HTMLInputElement).value)"
          />
        </label>
        <template v-if="row.traceql">
          <label class="ts-field">
            <span>{{ t('Service filter') }}</span>
            <input
              type="text"
              class="alias-input sm mono"
              :value="filterOf(row.store).pattern"
              placeholder="^agent::"
              :disabled="readOnly"
              spellcheck="false"
              @input="setFilter(row.store, 'pattern', ($event.target as HTMLInputElement).value)"
            />
          </label>
          <label class="ts-field check">
            <span>{{ t('Ignore case') }}</span>
            <input
              type="checkbox"
              :checked="ignoresCase(row.store)"
              :disabled="readOnly"
              @change="setIgnoreCase(row.store, ($event.target as HTMLInputElement).checked)"
            />
          </label>
        </template>
      </div>
      <p v-if="row.traceql && checked.has(row.store)" class="ts-hint sub">
        {{ t('The Tempo API has no notion of a layer, so it lists every service of the store. This pattern narrows the service PICKER only — result rows are never filtered, so cross-service traces still appear.') }}
      </p>
      <p v-if="filterInvalid(row.store)" class="ts-warn">
        {{ t('Horizon will not run this expression, so the picker keeps showing every service. It either does not compile, or it can backtrack exponentially — avoid a repeat applied to a group that itself repeats or branches, such as (a+)+.') }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.ts-list { display: flex; flex-direction: column; gap: 6px; }
.ts-item {
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  padding: 8px 10px;
  background: var(--sw-bg-1);
}
.ts-item.on { border-color: var(--sw-accent); background: var(--sw-bg-2); }
.ts-head { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.ts-name { font-size: 12.5px; color: var(--sw-fg-0); }
.ts-path {
  font-family: var(--sw-mono);
  font-size: 10px;
  color: var(--sw-fg-3);
  background: var(--sw-bg-2);
  border-radius: 3px;
  padding: 0 4px;
}
.ts-hint { margin: 3px 0 0 22px; font-size: 10.5px; color: var(--sw-fg-3); line-height: 1.4; }
.ts-hint.sub { margin-top: 5px; }
.ts-warn { margin: 5px 0 0 22px; font-size: 10.5px; color: var(--sw-warn); line-height: 1.4; }
.ts-fields { display: flex; flex-wrap: wrap; gap: 8px; margin: 7px 0 0 22px; }
.ts-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--sw-fg-3);
  min-width: 170px;
}
.ts-field.check { min-width: 0; flex-direction: row; align-items: center; gap: 6px; }
.alias-input {
  height: 28px;
  padding: 0 10px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 5px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 12px;
  width: 100%;
}
.alias-input:focus { outline: none; border-color: var(--sw-accent); }
.alias-input.mono { font-family: var(--sw-mono); }
</style>
