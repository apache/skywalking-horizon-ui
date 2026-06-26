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
import { useLayers } from '@/shell/useLayers';
import type { AlarmFilters } from './useAlarmFilters';

const { t } = useI18n();
const props = defineProps<{ filters: AlarmFilters; hasQueryAlarms: boolean }>();
const f = props.filters;
const draft = f.draft;
const applied = f.applied;

const { availableLayers } = useLayers();
</script>

<template>
  <div v-if="hasQueryAlarms" class="ax__filters">
    <label class="ax__filter">
      <span>{{ t('Layer') }}</span>
      <select v-model="draft.layer" @change="f.onLayerChange()">
        <option value="">{{ t('any layer') }}</option>
        <option v-for="L in availableLayers" :key="L.key" :value="L.key.toUpperCase()">{{ L.name }}</option>
      </select>
    </label>
    <label class="ax__filter" :class="{ 'is-disabled': !draft.layer }">
      <span>{{ t('Service') }}</span>
      <select v-model="draft.service" :disabled="!draft.layer" @change="f.onServiceChange()">
        <option value="">
          {{ !draft.layer ? t('pick a layer first') : f.servicesFetching.value ? t('loading…') : t('any service') }}
        </option>
        <option v-for="name in f.serviceOptions.value" :key="name" :value="name">{{ name }}</option>
      </select>
    </label>
    <label class="ax__filter" :class="{ 'is-disabled': !draft.service }">
      <span>{{ t('Instance') }}</span>
      <select v-model="draft.instance" :disabled="!draft.service">
        <option value="">
          {{ !draft.service ? t('pick a service first') : f.instancesFetching.value ? t('loading…') : t('any instance') }}
        </option>
        <option v-for="name in f.instanceOptions.value" :key="name" :value="name">{{ name }}</option>
      </select>
    </label>
    <label class="ax__filter" :class="{ 'is-disabled': !draft.service }">
      <span>{{ t('Endpoint') }}</span>
      <select v-model="draft.endpoint" :disabled="!draft.service">
        <option value="">
          {{ !draft.service ? t('pick a service first') : f.endpointsFetching.value ? t('loading…') : t('any endpoint') }}
        </option>
        <option v-for="name in f.endpointOptions.value" :key="name" :value="name">{{ name }}</option>
      </select>
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
.ax__filter select,
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
.ax__filter select {
  cursor: pointer;
  padding-right: 16px;
  background: transparent
    url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6' width='10' height='6'><path d='M1 1l4 4 4-4' stroke='%23818a9c' stroke-width='1.4' fill='none' stroke-linecap='round'/></svg>")
    right 2px center / 9px no-repeat;
}
.ax__filter select:disabled { cursor: not-allowed; background-image: none; color: var(--sw-fg-2); }
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
