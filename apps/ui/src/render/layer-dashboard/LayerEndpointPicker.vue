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
  Endpoint picker — same vertical-list shape as the instance picker, with a
  search input at the top driving findEndpoint. Endpoints are unbounded so we
  don't page through them; the BFF clamps the limit to 20…50. The cascade
  composable owns the fetch / auto-pick; this component is presentational and
  emits `pick` / `toggle-lock` / `submit` / `clear`.
-->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import Icon from '@/components/icons/Icon.vue';

interface LayerEndpoint {
  id: string;
  name: string;
}

defineProps<{
  slotLabel: string;
  serviceName: string | null;
  selectedId: string | null;
  endpoints: LayerEndpoint[];
  loading: boolean;
  selected: string | null;
  query: string;
  atCap: boolean;
  isLocked: (name: string) => boolean;
  rowHue: (name: string) => string;
}>();
const emit = defineEmits<{
  (e: 'pick', name: string): void;
  (e: 'toggle-lock', name: string): void;
  (e: 'submit'): void;
  (e: 'clear'): void;
}>();

const searchInput = defineModel<string>('searchInput', { required: true });
const limit = defineModel<number>('limit', { required: true });

const { t } = useI18n({ useScope: 'global' });
</script>

<template>
  <section class="instance-bar sw-card">
    <header class="ib-head">
      <span class="kicker">{{ slotLabel || 'Endpoint' }}</span>
      <!-- Strictly serviceName, no base64-id fallback (same rule
           as the instance picker above). -->
      <span v-if="serviceName" class="for-svc">
        for <b>{{ serviceName }}</b>
        <span v-if="endpoints.length > 0" class="count">{{ endpoints.length }}</span>
      </span>
      <span v-else-if="selectedId" class="hint">resolving service…</span>
      <span v-if="loading" class="hint">loading endpoints…</span>
    </header>
    <div v-if="!selectedId" class="empty inline">
      Pick a service in the picker above to search its endpoints.
    </div>
    <div v-else-if="!serviceName" class="empty inline">
      Resolving service…
    </div>
    <template v-else>
      <div class="ep-controls">
        <input
          class="ep-search"
          type="search"
          placeholder="Search endpoints, press Enter…"
          v-model="searchInput"
          @keydown.enter.prevent="emit('submit')"
          @search="emit('submit')"
        />
        <button
          class="sw-btn small"
          type="button"
          :disabled="searchInput === query"
          title="Run the search (Enter)"
          @click="emit('submit')"
        >Search</button>
        <button
          v-if="query"
          class="sw-btn ghost small"
          type="button"
          title="Clear the search keyword"
          @click="emit('clear')"
        >Clear</button>
        <label class="ep-limit" title="Endpoints are unbounded — limit clamps the top-N (20–50).">
          <span>Top</span>
          <select v-model.number="limit">
            <option :value="20">20</option>
            <option :value="30">30</option>
            <option :value="40">40</option>
            <option :value="50">50</option>
          </select>
        </label>
      </div>
      <div v-if="query" class="ep-active-query">
        Showing top {{ limit }} matches for
        <code>{{ query }}</code>
      </div>
      <div v-if="!loading && endpoints.length === 0" class="empty inline">
        No endpoints match
        <code v-if="query">{{ query }}</code>
        <span v-else>this service in the last 15 minutes</span>.
      </div>
      <ul v-else class="ib-list">
        <li
          v-for="e in endpoints"
          :key="e.id"
          class="ib-row has-lock"
          :class="{ on: selected === e.name }"
        >
          <button
            type="button"
            class="ib-lock"
            :class="{ locked: isLocked(e.name) }"
            :disabled="!isLocked(e.name) && atCap"
            :title="isLocked(e.name) ? t('Remove from comparison') : t('Add to comparison')"
            @click.stop="emit('toggle-lock', e.name)"
          >
            <span v-if="isLocked(e.name)" class="ib-lock-dot" :style="{ background: rowHue(e.name) }" />
            <Icon v-else name="pin" :size="11" />
          </button>
          <button
            type="button"
            class="ib-pick-btn"
            @click="emit('pick', e.name)"
          >
            <span class="ib-name">{{ e.name }}</span>
          </button>
        </li>
      </ul>
    </template>
  </section>
</template>

<style scoped>
.instance-bar {
  padding: 0;
  display: flex;
  flex-direction: column;
  max-height: 360px;
}
.ib-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
}
.ib-head .kicker {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sw-accent);
  font-weight: 600;
}
.ib-head .for-svc {
  font-size: 11px;
  color: var(--sw-fg-3);
}
.ib-head .for-svc b {
  color: var(--sw-fg-1);
  font-weight: 500;
  font-family: var(--sw-mono);
}
.ib-head .count {
  font-family: var(--sw-mono);
  font-size: 10px;
  padding: 1px 6px;
  margin-left: 6px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-2);
  border-radius: 3px;
}
.ib-head .hint {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.empty {
  padding: 32px;
  text-align: center;
  color: var(--sw-fg-3);
  font-size: 12px;
}
.empty.inline {
  padding: 18px;
  font-size: 11px;
}
.ib-list {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.ib-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 4px 8px;
  padding: 2px 10px;
  border-bottom: 1px solid var(--sw-line);
}
.ib-row.has-lock {
  grid-template-columns: auto 1fr auto;
}
.ib-lock {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  align-self: center;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--sw-fg-3);
  cursor: pointer;
}
.ib-lock:hover:not(:disabled) {
  color: var(--sw-fg-1);
  background: var(--sw-bg-2);
}
.ib-lock:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.ib-lock-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.ib-row:last-child { border-bottom: none; }
.ib-row.on {
  background: var(--sw-accent-soft);
}
.ib-pick-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--sw-fg-1);
  font: inherit;
  font-family: var(--sw-mono);
  font-size: 11.5px;
  text-align: left;
  cursor: pointer;
  min-width: 0;
}
.ib-pick-btn:hover {
  background: var(--sw-bg-2);
  color: var(--sw-fg-0);
}
.ib-row.on .ib-pick-btn {
  color: var(--sw-accent-2);
  font-weight: 600;
  background: transparent;
}
.ib-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Endpoint picker controls — search box + top-N limit selector,
 * laid out as a row above the endpoint list. */
.ep-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px 8px;
  border-bottom: 1px solid var(--sw-line);
}
.ep-search {
  flex: 1;
  height: 26px;
  padding: 0 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11.5px;
}
.ep-search:focus {
  outline: none;
  border-color: var(--sw-accent-line);
}
.ep-limit {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.ep-limit select {
  height: 26px;
  padding: 0 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11.5px;
}
.ep-active-query {
  padding: 4px 12px;
  font-size: 10.5px;
  color: var(--sw-fg-3);
  border-bottom: 1px dashed var(--sw-line);
}
.ep-active-query code {
  font-family: var(--sw-mono);
  font-size: 10.5px;
  color: var(--sw-accent-2);
  padding: 0 4px;
  background: var(--sw-accent-soft);
  border-radius: 2px;
}
</style>
