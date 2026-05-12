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
<script setup lang="ts">
import { computed, ref } from 'vue';
import LayerSetupCard from './LayerSetupCard.vue';
import { useLayers } from '@/composables/useLayers';
import { useSetupStore } from '@/stores/setup';

const { layers, oapReachable, oapError, isLoading } = useLayers();
const store = useSetupStore();

// Order by priority (lower first), with active layers always above inactive at
// the same priority. The layer order on the landing will mirror this.
const orderedLayers = computed(() =>
  [...layers.value].sort((a, b) => {
    const pa = store.ensure(a.key, { slots: a.slots, caps: a.caps }).landing.priority;
    const pb = store.ensure(b.key, { slots: b.slots, caps: b.caps }).landing.priority;
    if (pa !== pb) return pa - pb;
    if (a.active !== b.active) return a.active ? -1 : 1;
    return a.name.localeCompare(b.name);
  }),
);

const enabledOnLanding = computed(() =>
  orderedLayers.value.filter((L) => store.ensure(L.key, { slots: L.slots, caps: L.caps }).landing.enabled),
);

const filter = ref<'all' | 'active' | 'enabled'>('all');
const visibleLayers = computed(() => {
  if (filter.value === 'active') return orderedLayers.value.filter((L) => L.active);
  if (filter.value === 'enabled')
    return orderedLayers.value.filter((L) =>
      store.ensure(L.key, { slots: L.slots, caps: L.caps }).landing.enabled,
    );
  return orderedLayers.value;
});
</script>

<template>
  <div class="setup">
    <header class="page-head">
      <div>
        <div class="kicker">Setup</div>
        <h1>Configure layers and the landing page</h1>
        <p class="lede">
          Each detected layer can appear on the landing as its own card with the top services and a
          set of metrics. Pick which layers show up, set their priority, choose the columns, and
          rename slots if the default terms don't fit. Inactive layers (no data) can still be
          configured — they appear once their receiver starts reporting.
        </p>
      </div>
      <div class="kpi-strip">
        <div class="kpi">
          <span class="kpi-label">Detected</span>
          <span class="kpi-value">{{ layers.length }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">Active</span>
          <span class="kpi-value">{{ layers.filter((L) => L.active).length }}</span>
        </div>
        <div class="kpi">
          <span class="kpi-label">On landing</span>
          <span class="kpi-value">{{ enabledOnLanding.length }}</span>
        </div>
      </div>
    </header>

    <div v-if="!oapReachable && !isLoading" class="banner err">
      <strong>OAP unreachable.</strong>
      {{ oapError ?? 'Check that the OAP query host is up and reachable from the BFF.' }}
      Layer detection runs against <code>/graphql</code> on the OAP host configured in
      <code>horizon.yaml</code>.
    </div>

    <div v-if="layers.length === 0 && !isLoading" class="empty">
      <div class="empty-card">
        <div class="empty-icon">○</div>
        <h2>No layers detected</h2>
        <p>
          Once data starts flowing through OAP — agents reporting, OTel collectors forwarding,
          virtual receivers ingesting — the layers will appear here.
        </p>
      </div>
    </div>

    <template v-else>
      <div class="controls">
        <div class="seg">
          <button class="seg-btn" :class="{ on: filter === 'all' }" @click="filter = 'all'">
            All <span class="count">{{ orderedLayers.length }}</span>
          </button>
          <button class="seg-btn" :class="{ on: filter === 'active' }" @click="filter = 'active'">
            Active <span class="count">{{ layers.filter((L) => L.active).length }}</span>
          </button>
          <button class="seg-btn" :class="{ on: filter === 'enabled' }" @click="filter = 'enabled'">
            On landing <span class="count">{{ enabledOnLanding.length }}</span>
          </button>
        </div>
      </div>

      <div class="cards">
        <LayerSetupCard v-for="L in visibleLayers" :key="L.key" :layer="L" />
      </div>

      <footer class="page-foot">
        <div class="foot-left">
          <strong>{{ enabledOnLanding.length }}</strong> layer(s) enabled on the landing,
          in priority order:
          <span v-for="(L, i) in enabledOnLanding" :key="L.key" class="chip-name">
            {{ L.name }}<span v-if="i < enabledOnLanding.length - 1">,</span>
          </span>
        </div>
        <div class="foot-right">
          <span class="hint">Persistence wires in at Stage 2.4. For now, changes live in this tab only.</span>
        </div>
      </footer>
    </template>
  </div>
</template>

<style scoped>
.setup {
  padding: 20px 20px 60px;
  max-width: 980px;
  margin: 0 auto;
}
.page-head {
  display: flex;
  gap: 24px;
  align-items: flex-end;
  margin-bottom: 18px;
}
.page-head > div:first-child {
  flex: 1;
  min-width: 0;
}
.kicker {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sw-accent);
  margin-bottom: 6px;
}
.page-head h1 {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--sw-fg-0);
  margin: 0 0 8px;
}
.lede {
  font-size: 12.5px;
  color: var(--sw-fg-1);
  line-height: 1.5;
  margin: 0;
  max-width: 640px;
}
.kpi-strip {
  display: flex;
  gap: 14px;
  flex: 0 0 auto;
}
.kpi {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  padding: 8px 14px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  min-width: 84px;
}
.kpi-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-2);
}
.kpi-value {
  font-size: 20px;
  font-weight: 600;
  color: var(--sw-fg-0);
}
.banner.err {
  margin: 0 0 16px;
  padding: 10px 12px;
  background: var(--sw-err-soft);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  color: #f87171;
  font-size: 12px;
  line-height: 1.5;
}
.banner.err code {
  background: var(--sw-bg-2);
  padding: 1px 5px;
  border-radius: 3px;
  font-family: var(--sw-mono);
  font-size: 10.5px;
  color: var(--sw-fg-1);
}
.empty {
  margin-top: 20px;
}
.empty-card {
  background: var(--sw-bg-1);
  border: 1px dashed var(--sw-line-2);
  border-radius: 10px;
  padding: 28px;
  text-align: center;
}
.empty-card .empty-icon {
  font-size: 36px;
  color: var(--sw-fg-3);
  margin-bottom: 6px;
}
.empty-card h2 {
  font-size: 15px;
  color: var(--sw-fg-0);
  margin: 0 0 6px;
}
.empty-card p {
  font-size: 12px;
  color: var(--sw-fg-2);
  margin: 0;
}
.controls {
  display: flex;
  align-items: center;
  margin-bottom: 12px;
}
.seg {
  display: flex;
  gap: 0;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  overflow: hidden;
}
.seg-btn {
  height: 28px;
  padding: 0 12px;
  background: transparent;
  border: 0;
  color: var(--sw-fg-2);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.seg-btn:not(:last-child) {
  border-right: 1px solid var(--sw-line);
}
.seg-btn.on {
  background: var(--sw-bg-3);
  color: var(--sw-fg-0);
}
.seg-btn .count {
  font-size: 10px;
  color: var(--sw-fg-3);
  padding: 0 5px;
  background: var(--sw-bg-2);
  border-radius: 3px;
}
.seg-btn.on .count {
  color: var(--sw-fg-1);
  background: var(--sw-bg-2);
}
.cards {
  display: flex;
  flex-direction: column;
}
.page-foot {
  margin-top: 18px;
  padding: 12px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  display: flex;
  align-items: center;
  gap: 12px;
}
.foot-left {
  font-size: 12px;
  color: var(--sw-fg-1);
  flex: 1;
  min-width: 0;
}
.foot-left strong {
  color: var(--sw-accent-2);
  font-weight: 700;
}
.chip-name {
  color: var(--sw-fg-0);
}
.foot-right .hint {
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
</style>
