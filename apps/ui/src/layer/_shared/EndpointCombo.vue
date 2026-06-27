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
  Search-and-select endpoint combobox: one input that doubles as the
  search field (its debounced value rides up via `update:query`, the host
  threads it into the OAP `findEndpoint` query) AND the displayed
  selection. The dropdown opens on focus/typing, closes on click-outside
  (handled by `useEndpointCombo`) or after a pick. Feature-agnostic — the
  host owns the endpoint list + the selected value; this owns only the
  typing/open mechanics. Reused by the Logs + Browser Logs pickers.

  `selected` is the currently-picked endpoint name (drives the `.on`
  highlight + the placeholder); empty/`null` means "All". `showAll` gates
  whether the dropdown lists an explicit `All` row (an endpoint-pinned
  layer has no "All" choice).
-->
<script setup lang="ts">
import { watch } from 'vue';
import { useEndpointCombo } from '@/layer/_shared/useEndpointCombo';

const props = withDefaults(
  defineProps<{
    endpoints: ReadonlyArray<{ id: string; name: string }>;
    selected: string | null;
    showAll?: boolean;
    loading?: boolean;
    placeholder?: string;
  }>(),
  { showAll: true, loading: false, placeholder: 'All' },
);

const emit = defineEmits<{
  pick: [name: string];
  clear: [];
  'update:query': [query: string];
}>();

const combo = useEndpointCombo();
watch(combo.query, (q) => emit('update:query', q));
// Mirror the parent's selection into the input so a parent-side clear/change
// resets the displayed text (setDisplay skips the search debounce).
watch(() => props.selected, (sel) => combo.setDisplay(sel ?? ''));

function pick(name: string): void {
  combo.setDisplay(name);
  combo.open.value = false;
  emit('pick', name);
}
function clear(): void {
  combo.reset();
  emit('clear');
}
</script>

<template>
  <div :ref="(el) => (combo.el.value = (el as HTMLElement | null))" class="cf-combo" @click.stop>
    <input
      v-model="combo.searchInput.value"
      type="text"
      name="endpoint-search"
      autocomplete="off"
      class="cf-input"
      :placeholder="selected ?? placeholder"
      @focus="combo.open.value = true"
      @input="combo.open.value = true"
    />
    <button
      v-if="selected || combo.searchInput.value"
      type="button"
      class="cf-combo-clear"
      title="Clear endpoint"
      @click="clear"
    >×</button>
    <ul v-if="combo.open.value" class="cf-combo-list">
      <li
        v-if="showAll"
        class="cf-combo-item"
        :class="{ on: !selected }"
        @click="clear"
      >
        <em>All</em>
      </li>
      <li
        v-for="e in endpoints"
        :key="e.id"
        class="cf-combo-item"
        :class="{ on: selected === e.name }"
        @click="pick(e.name)"
      >
        {{ e.name }}
      </li>
      <li v-if="endpoints.length === 0" class="cf-combo-empty">
        {{ loading ? 'searching…' : 'no matches' }}
      </li>
    </ul>
  </div>
</template>

<style scoped>
/* Endpoint combobox = single search input + anchored dropdown.
   Click-outside closes it (see `useEndpointCombo`). */
.cf-combo { position: relative; }
.cf-input {
  height: 28px;
  padding: 0 8px;
  padding-right: 22px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11px;
  width: 100%;
  box-sizing: border-box;
}
.cf-input:focus { outline: none; border-color: var(--sw-accent-line); }
.cf-combo-clear {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  width: 16px;
  height: 16px;
  line-height: 14px;
  padding: 0;
  background: transparent;
  border: none;
  color: var(--sw-fg-3);
  font-size: 13px;
  cursor: pointer;
}
.cf-combo-clear:hover { color: var(--sw-err); }
.cf-combo-list {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  margin: 4px 0 0;
  padding: 4px;
  max-height: 240px;
  overflow-y: auto;
  list-style: none;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  z-index: 50;
  box-shadow: 0 8px 24px rgba(0,0,0,0.45);
}
.cf-combo-item {
  padding: 5px 8px;
  font-size: 11px;
  font-family: var(--sw-mono);
  color: var(--sw-fg-1);
  border-radius: 3px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cf-combo-item em { color: var(--sw-fg-1); font-style: normal; font-family: var(--sw-mono); }
.cf-combo-item:hover { background: var(--sw-bg-2); color: var(--sw-fg-0); }
.cf-combo-item.on { background: var(--sw-accent-soft); color: var(--sw-accent-2); font-weight: 600; }
.cf-combo-empty { padding: 6px 8px; font-size: 10.5px; color: var(--sw-fg-3); }
</style>
