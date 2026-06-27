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
  Node visibility filter — floating overlay (top-left) shown in BOTH the
  full Topology tab and the embedded overview widget. One auto-derived
  facet — LAYER (`node.layers`, multi-valued ⇒ any-match) — plus a
  standalone toggle for the synthetic `User` node. Buckets store
  EXCLUSIONS (a node is hidden when its layer is in the set), so a freshly-
  appearing layer defaults visible. The owner reads `hiddenLayers` /
  `hideUser` (both v-model) to compute the visible node set; this
  component only derives facets + renders the popover.
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useEscapeToClose } from '@/components/primitives/useEscapeToClose';
import type { LayerDef, TopologyNode } from '@/api/client';
import { isUserNode } from '@/layer/service-map/useTopologyIcons';
import Icon from '@/components/icons/Icon.vue';
import { layerIcon } from '@/shell/icons';

const props = defineProps<{
  nodes: TopologyNode[];
  layers: LayerDef[];
  hiddenLayers: Set<string>;
  hideUser: boolean;
  embedded: boolean;
}>();
const emit = defineEmits<{
  'update:hiddenLayers': [Set<string>];
  'update:hideUser': [boolean];
}>();

const OTHERS_TOKEN = 'UNDEFINED'; // OAP's no-layer fallback, shown as "Others"
const filterOpen = ref(false);
useEscapeToClose(() => filterOpen.value, () => { filterOpen.value = false; });

function layerTokens(n: TopologyNode): string[] {
  const ls = (n.layers ?? []).filter((l) => l && l.length > 0);
  return ls.length > 0 ? ls : [OTHERS_TOKEN];
}
// Layer facet label = the BFF's already-localized layer display name (the
// same `LayerDef.name` the sidebar renders). A layer that isn't in the
// served menu falls back to a title-cased enum.
function titleCaseEnum(raw: string): string {
  return raw.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
function layerLabel(token: string): string {
  if (token === OTHERS_TOKEN) return 'Others';
  const def = props.layers.find((l) => l.key === token.toLowerCase());
  return def?.name ?? titleCaseEnum(token);
}

interface Facet { token: string; label: string; count: number }
function facetList(
  counts: Map<string, number>,
  label: (tok: string) => string,
  tail: string,
): Facet[] {
  const rows = [...counts.entries()].map(([token, count]) => ({ token, label: label(token), count }));
  rows.sort((a, b) => {
    // Pin the catch-all bucket (Others / Unknown) to the bottom.
    if (a.token === tail) return 1;
    if (b.token === tail) return -1;
    const al = a.label.toLowerCase();
    const bl = b.label.toLowerCase();
    return al < bl ? -1 : al > bl ? 1 : 0;
  });
  return rows;
}
// Facets derive from the FULL node set (minus User, which owns its own
// toggle) so toggling a row off never makes that row disappear.
const layerFacets = computed<Facet[]>(() => {
  const counts = new Map<string, number>();
  for (const n of props.nodes) {
    if (isUserNode(n)) continue;
    for (const tok of layerTokens(n)) counts.set(tok, (counts.get(tok) ?? 0) + 1);
  }
  return facetList(counts, layerLabel, OTHERS_TOKEN);
});
const hasUserNode = computed<boolean>(() => props.nodes.some(isUserNode));
const userNodeCount = computed<number>(() => props.nodes.filter(isUserNode).length);

const filterActive = computed<boolean>(
  () => props.hideUser || props.hiddenLayers.size > 0,
);
const hiddenCount = computed<number>(
  () => (props.hideUser ? 1 : 0) + props.hiddenLayers.size,
);
function toggleFilter(): void { filterOpen.value = !filterOpen.value; }
function toggleLayerFacet(tok: string): void {
  const s = new Set(props.hiddenLayers);
  if (s.has(tok)) s.delete(tok);
  else s.add(tok);
  emit('update:hiddenLayers', s);
}
function toggleUser(): void { emit('update:hideUser', !props.hideUser); }
function resetFilter(): void {
  emit('update:hiddenLayers', new Set());
  emit('update:hideUser', false);
}

defineExpose({ filterActive });
</script>

<template>
  <div class="sm-filter-ctrls" :class="{ embedded }" @click.stop>
    <button
      class="sw-btn small filter-btn"
      type="button"
      :class="{ active: filterActive }"
      :title="filterActive ? `${hiddenCount} filter(s) active — click to edit` : 'Filter nodes'"
      @click="toggleFilter"
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M2 3h12l-4.6 5.8v4.3l-2.8 1.4V8.8z" />
      </svg>
      <span v-if="!embedded" class="filter-btn-label">Filter</span>
      <span v-if="filterActive" class="filter-badge">{{ hiddenCount }}</span>
    </button>
    <div v-if="filterOpen" class="sm-filter-pop sw-card">
      <div class="sf-head">
        <span class="sf-title">Show nodes</span>
        <button v-if="filterActive" class="sf-reset" type="button" @click="resetFilter">Reset</button>
      </div>
      <div v-if="hasUserNode" class="sf-group">
        <button class="sf-row" type="button" @click="toggleUser">
          <span class="sf-check" :class="{ on: !hideUser }" />
          <span class="sf-name">User</span>
          <span class="sf-count">{{ userNodeCount }}</span>
        </button>
      </div>
      <div v-if="layerFacets.length > 0" class="sf-group">
        <div class="sf-group-head">Layers</div>
        <button
          v-for="f in layerFacets"
          :key="'l-' + f.token"
          class="sf-row"
          type="button"
          @click="toggleLayerFacet(f.token)"
        >
          <span class="sf-check" :class="{ on: !hiddenLayers.has(f.token) }" />
          <Icon :name="layerIcon(f.token)" class="sf-layer-icon" />
          <span class="sf-name">{{ f.label }}</span>
          <span class="sf-count">{{ f.count }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Node filter control — top-left of the map, mirroring the zoom
   controls' glass vocabulary. Shown in BOTH the tab and the embedded
   widget (unlike the zoom controls, which the widget hides). The
   popover lists the auto-derived facets; in embedded mode it shrinks
   so it fits a dashboard-cell footprint. */
.sm-filter-ctrls {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 12;
}
.filter-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px;
}
.filter-btn.active {
  border-color: var(--sw-accent-line);
  color: var(--sw-accent-2);
}
.filter-btn-label {
  font-size: 11px;
}
.filter-badge {
  font-size: 9.5px;
  font-weight: 700;
  min-width: 14px;
  height: 14px;
  padding: 0 4px;
  border-radius: 7px;
  background: var(--sw-accent);
  color: var(--sw-bg-0);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.sm-filter-pop {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  width: 224px;
  max-height: 320px;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sm-filter-ctrls.embedded .sm-filter-pop {
  width: 196px;
  max-height: 232px;
}
.sf-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.sf-title {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
  font-weight: 700;
}
.sf-reset {
  background: transparent;
  border: 0;
  color: var(--sw-accent-2);
  font: inherit;
  font-size: 10.5px;
  cursor: pointer;
  padding: 0;
}
.sf-group {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.sf-group-head {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
  padding: 4px 4px 2px;
  font-weight: 600;
}
.sf-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 4px 6px;
  background: transparent;
  border: 0;
  border-radius: 4px;
  color: var(--sw-fg-1);
  font: inherit;
  font-size: 11.5px;
  text-align: left;
  cursor: pointer;
}
.sf-row:hover {
  background: var(--sw-bg-2);
  color: var(--sw-fg-0);
}
.sf-check {
  width: 12px;
  height: 12px;
  border: 1.5px solid var(--sw-line-2);
  border-radius: 3px;
  flex: 0 0 auto;
  box-sizing: border-box;
}
.sf-check.on {
  background: var(--sw-accent);
  border-color: var(--sw-accent);
}
.sf-layer-icon {
  flex: 0 0 auto;
  color: var(--sw-fg-2);
}
.sf-name {
  flex: 1;
  font-family: var(--sw-mono);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sf-count {
  font-size: 10px;
  color: var(--sw-fg-3);
  font-family: var(--sw-mono);
}
</style>
