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
  Alarms filter row. Two faces, picked by `hasQueryAlarms`:
   - New: layer · service · instance · endpoint · keyword cascade.
          Dependent dropdowns populate off the draft; apply commits.
   - Legacy: keyword only, with an upgrade hint. Server-side entity
          filters gracefully no-op on older OAP.

  Binds an `AlarmFilters` state machine (see useAlarmFilters.ts); owns
  no alarm data, only the layer catalog for the layer dropdown.
-->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { computed } from 'vue';
import { useLayers } from '@/shell/useLayers';
import { useAuthStore } from '@/state/auth';
import { canonicalLayerKey } from '@/state/verbGrammar';
import TypeaheadSelect from '@/components/primitives/TypeaheadSelect.vue';
import type { AlarmFilters } from './useAlarmFilters';
import { entryLayerName, entryOf } from '@/utils/layerRoute';

const { t } = useI18n();
const props = defineProps<{
  filters: AlarmFilters;
  hasQueryAlarms: boolean;
  /** On a named page, the layers its pins name: the only ones offered. */
  pageLayers?: readonly string[] | null;
}>();
const f = props.filters;
const draft = f.draft;
const applied = f.applied;

const { availableLayers, alarmLayers } = useLayers();
const auth = useAuthStore();
const limitedLayers = computed(() => auth.layersFor('alarms:read'));
/** One option per OAP layer. A layer split by service group is several menu
 *  entries, and the filter takes the layer alone. */
const baseLayers = computed(() => {
  const out = new Map<string, string>();
  for (const L of availableLayers.value) {
    const key = canonicalLayerKey(entryOf(L).layer);
    if (!out.has(key) || !L.serviceGroup) out.set(key, entryLayerName(L));
  }
  return out;
});
const readableLayers = computed(() => {
  // With layer grants the sidebar follows page permissions, not alarms:read,
  // so the BFF lists the alarm layers on their own.
  if (alarmLayers.value) return alarmLayers.value;
  const limited = limitedLayers.value;
  if (!limited) return [...baseLayers.value].map(([key, name]) => ({ key, name }));
  return limited.map((key) => ({ key, name: baseLayers.value.get(key) ?? key }));
});
const layerOptions = computed(() => {
  const only = props.pageLayers;
  if (!only) return readableLayers.value;
  // The page's pins are already narrowed to what the reader reaches.
  return only.map((key) => readableLayers.value.find((L) => L.key === key) ?? { key, name: baseLayers.value.get(key) ?? key });
});

const layerPicks = computed(() => [
  { value: '', label: t('any layer') },
  ...layerOptions.value.map((L) => ({ value: L.key, label: L.name })),
]);
const servicePicks = computed(() => {
  const d = draft.value;
  const any = !d.layer ? t('pick a layer first') : f.servicesFetching.value ? t('loading…') : t('any service');
  // A normal and a conjectural service can share a name, and the filter binds
  // the name alone: one row per name.
  const names = new Set(f.serviceOptions.value.map((s) => s.name));
  return [{ value: '', label: any }, ...[...names].map((name) => ({ value: name, label: name }))];
});
function entityPicks(names: readonly string[], fetching: boolean, any: string): Array<{ value: string; label: string }> {
  const first = !draft.value.service ? t('pick a service first') : fetching ? t('loading…') : any;
  return [{ value: '', label: first }, ...names.map((name) => ({ value: name, label: name }))];
}
const instancePicks = computed(() => entityPicks(f.instanceOptions.value, f.instancesFetching.value, t('any instance')));
const endpointPicks = computed(() => entityPicks(f.endpointOptions.value, f.endpointsFetching.value, t('any endpoint')));

// The picker emits on every pick, the same value included; re-picking the
// layer or service must not clear what was picked below it.
function pickLayer(v: string): void {
  if (v === draft.value.layer) return;
  draft.value.layer = v;
  f.onLayerChange();
}
function pickService(v: string): void {
  if (v === draft.value.service) return;
  draft.value.service = v;
  f.onServiceChange();
}
</script>

<template>
  <div v-if="hasQueryAlarms" class="ax__filters">
    <label class="ax__filter">
      <span>{{ t('Layer') }}</span>
      <TypeaheadSelect
        :model-value="draft.layer"
        :options="layerPicks"
        :aria-label="t('Layer')"
        block
        @update:model-value="pickLayer"
      />
    </label>
    <label class="ax__filter" :class="{ 'is-disabled': !draft.layer }">
      <span>{{ t('Service') }}</span>
      <TypeaheadSelect
        :model-value="draft.service"
        :options="servicePicks"
        :disabled="!draft.layer"
        :aria-label="t('Service')"
        :min-panel-width="300"
        block
        @update:model-value="pickService"
      />
    </label>
    <label class="ax__filter" :class="{ 'is-disabled': !draft.service }">
      <span>{{ t('Instance') }}</span>
      <TypeaheadSelect
        v-model="draft.instance"
        :options="instancePicks"
        :disabled="!draft.service"
        :aria-label="t('Instance')"
        :min-panel-width="300"
        block
      />
    </label>
    <label class="ax__filter" :class="{ 'is-disabled': !draft.service }">
      <span>{{ t('Endpoint') }}</span>
      <TypeaheadSelect
        v-model="draft.endpoint"
        :options="endpointPicks"
        :disabled="!draft.service"
        :aria-label="t('Endpoint')"
        :min-panel-width="300"
        block
      />
    </label>
    <label class="ax__filter ax__filter--wide">
      <span>{{ t('Keyword') }}</span>
      <input v-model="draft.keyword" type="text" :placeholder="t('match alarm message')" />
    </label>
    <button
      type="button"
      class="ax__filter-apply"
      :class="{ 'is-dirty': f.isDirty.value }"
      :disabled="!f.isDirty.value"
      @click="f.applyFilters()"
    >{{ f.isDirty.value ? t('apply') : t('applied') }}</button>
    <button
      v-if="applied.layer || applied.service || applied.instance || applied.endpoint || applied.keyword"
      type="button"
      class="ax__filter-clear"
      @click="f.clearFilters()"
    >{{ t('clear') }}</button>
  </div>
  <div v-else class="ax__filters ax__filters--legacy">
    <label class="ax__filter ax__filter--wide">
      <span>{{ t('Keyword') }}</span>
      <input v-model="draft.keyword" type="text" :placeholder="t('match alarm message')" />
    </label>
    <button
      type="button"
      class="ax__filter-apply"
      :class="{ 'is-dirty': f.isDirty.value }"
      :disabled="!f.isDirty.value"
      @click="f.applyFilters()"
    >{{ f.isDirty.value ? t('apply') : t('applied') }}</button>
    <span class="ax__legacy-note">
      {{ t('This OAP version supports keyword + tag filters only. Upgrade for layer + entity filters.') }}
    </span>
  </div>
</template>

<style scoped>
.ax__filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: stretch;
  margin-bottom: 14px;
  padding: 10px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
}
.ax__filter {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 170px;
  padding: 6px 10px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  border-radius: 5px;
  cursor: pointer;
}
.ax__filter--wide { flex: 1; min-width: 220px; }
.ax__filter:hover:not(.is-disabled) { border-color: var(--sw-line-2); }
.ax__filter:focus-within:not(.is-disabled) { border-color: var(--sw-accent); }
.ax__filter.is-disabled { opacity: 0.45; cursor: not-allowed; }
.ax__filter > span {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
  font-weight: 600;
}
.ax__filter input[type='text'] {
  -webkit-appearance: none;
  -moz-appearance: none;
  appearance: none;
  background: transparent;
  border: 0;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 12px;
  padding: 1px 0;
  margin: 0;
  width: 100%;
  outline: none;
}
/* The card draws the box; the picker's trigger sits flat inside it. */
.ax__filter :deep(.tas__trigger) {
  min-width: 0;
  padding: 1px 0;
  background: transparent;
  border: 0;
  color: var(--sw-fg-0);
  font-size: 12px;
}
/* The card already dims a disabled picker. */
.ax__filter :deep(.tas__trigger:disabled) { opacity: 1; color: var(--sw-fg-2); }
/* Focus moves into the open list's search box, which is outside the card. */
.ax__filter:has(.tas.is-open) { border-color: var(--sw-accent); }
.ax__filter-apply {
  align-self: stretch;
  display: inline-flex;
  align-items: center;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-2);
  font: inherit;
  font-size: 11.5px;
  font-weight: 500;
  padding: 0 16px;
  border-radius: 5px;
  cursor: pointer;
  margin-left: auto;
}
.ax__filter-apply.is-dirty {
  background: var(--sw-accent);
  border-color: var(--sw-accent);
  color: #0a0d12;
  font-weight: 600;
}
.ax__filter-apply:disabled { cursor: default; }
.ax__filter-clear {
  align-self: stretch;
  display: inline-flex;
  align-items: center;
  background: transparent;
  border: 1px dashed var(--sw-line-2);
  color: var(--sw-fg-2);
  font: inherit;
  font-size: 11px;
  padding: 0 14px;
  border-radius: 5px;
  cursor: pointer;
}
.ax__filter-clear:hover { background: var(--sw-bg-2); color: var(--sw-fg-0); border-style: solid; }
.ax__filters--legacy { align-items: center; gap: 12px; }
.ax__legacy-note {
  font-size: 11px;
  color: var(--sw-fg-3);
  font-style: italic;
}
</style>
