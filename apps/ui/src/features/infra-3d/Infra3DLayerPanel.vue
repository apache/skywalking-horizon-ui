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
  Infra3DLayerPanel — the right-side tier → layer/logic-group panel.

  Two levels: a tier row per config level, with its layers + logic groups
  nested beneath. Clicking a tier row focuses + flashes the whole tier;
  clicking a layer/group row focuses that one zone; the eye toggles the
  whole tier's visibility. The panel derives its own counts + visibility
  state from the zones / nodes / visible-layer set the parent passes in,
  and emits the camera + toggle intents back for the parent (which owns
  the scene handle) to act on.
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { SceneServiceNode } from './composables/useMapTopology';
import { zoneLayerKeys, type ZonePlacement } from './composables/useScenePlacement';
import type { useInfra3dConfig } from './composables/useInfra3dConfig';

const props = defineProps<{
  zones: ZonePlacement[];
  nodesByLayer: Record<string, SceneServiceNode[]>;
  visibleLayers: Set<string>;
  /** The unwrapped value of the config's `levelsOrdered` ref — Vue unwraps
   *  the ref when it's bound as a prop, so the prop type is the array. */
  levelsOrdered: ReturnType<typeof useInfra3dConfig>['levelsOrdered']['value'];
}>();

const emit = defineEmits<{
  (e: 'tier-focus', planeId: string): void;
  (e: 'zone-focus', zoneKey: string): void;
  (e: 'toggle-plane', planeId: string): void;
  (e: 'reset'): void;
}>();

function servicesIn(key: string): number {
  return props.nodesByLayer[key]?.length ?? 0;
}

interface PanelEntry {
  kind: 'layer' | 'group';
  key: string;
  name: string;
  color?: string;
  services: number;
}
/** Side-panel hierarchy: tier → layer | logic-group (2 levels). Order
 *  matches `levels` from the admin config (apps on top, infra at the
 *  bottom by default). */
const panelTree = computed(() =>
  (props.levelsOrdered ?? []).map((lvl) => {
    const tierZones = props.zones.filter((z) => z.plane === lvl.id);
    const entries: PanelEntry[] = tierZones.map((z) =>
      z.group
        ? {
            kind: 'group',
            key: z.layerKey,
            name: z.layerName,
            color: z.group.color,
            services: z.group.layerKeys.reduce((a, k) => a + servicesIn(k), 0),
          }
        : { kind: 'layer', key: z.layerKey, name: z.layerName, services: servicesIn(z.layerKey) },
    );
    return { id: lvl.id, name: lvl.label, zones: tierZones, entries };
  }),
);

/** "all" → every layer in this tier is on; "none" → every layer is
 *  off; "some" → mixed. Drives the eye-toggle icon state and the
 *  hidden-row class on the tier row. */
function tierVisibility(tierZones: ZonePlacement[]): 'all' | 'some' | 'none' {
  const keys = tierZones.flatMap(zoneLayerKeys);
  if (keys.length === 0) return 'none';
  let on = 0;
  for (const k of keys) if (props.visibleLayers.has(k)) on++;
  if (on === 0) return 'none';
  if (on === keys.length) return 'all';
  return 'some';
}
function visibleServicesInTier(tierZones: ZonePlacement[]): number {
  let n = 0;
  for (const k of tierZones.flatMap(zoneLayerKeys)) {
    if (!props.visibleLayers.has(k)) continue;
    n += (props.nodesByLayer[k] || []).length;
  }
  return n;
}
function totalServicesInTier(tierZones: ZonePlacement[]): number {
  let n = 0;
  for (const k of tierZones.flatMap(zoneLayerKeys)) n += (props.nodesByLayer[k] || []).length;
  return n;
}
</script>

<template>
  <aside class="layer-panel">
    <div class="panel-head">
      <span>Tiers</span>
      <button type="button" class="panel-reset" title="Reset the view to the default framing" @click="emit('reset')">⌂ Reset</button>
    </div>
    <div class="panel-body">
      <ul class="tier-list">
        <li
          v-for="g in panelTree"
          :key="g.id"
          class="tier-block"
          :class="{ hidden: tierVisibility(g.zones) === 'none' }"
        >
          <div class="tier-item" @click="emit('tier-focus', g.id)">
            <span class="grp-dot" :data-plane="g.id" />
            <span class="tier-name">{{ g.name }}</span>
            <span class="tier-stat">
              {{ visibleServicesInTier(g.zones) }} / {{ totalServicesInTier(g.zones) }}
            </span>
            <button
              type="button"
              class="eye-btn"
              :title="tierVisibility(g.zones) === 'all' ? 'hide this tier' : 'show this tier'"
              :aria-pressed="tierVisibility(g.zones) !== 'none'"
              @click.stop="emit('toggle-plane', g.id)"
            >
              <svg v-if="tierVisibility(g.zones) !== 'none'" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path d="M8 4c-3.5 0-6 4-6 4s2.5 4 6 4 6-4 6-4-2.5-4-6-4z" fill="none" stroke="currentColor" stroke-width="1.4" />
                <circle cx="8" cy="8" r="2" fill="currentColor" />
              </svg>
              <svg v-else viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path d="M8 4c-3.5 0-6 4-6 4s2.5 4 6 4 6-4 6-4-2.5-4-6-4z" fill="none" stroke="currentColor" stroke-width="1.4" opacity="0.6" />
                <line x1="2.5" y1="2.5" x2="13.5" y2="13.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
              </svg>
            </button>
          </div>

          <ul v-if="g.entries.length" class="layer-sublist">
            <li
              v-for="e in g.entries"
              :key="e.key"
              class="layer-row"
              :class="{ 'is-group': e.kind === 'group' }"
              :title="`Focus ${e.name}`"
              @click="emit('zone-focus', e.key)"
            >
              <span class="lr-dot" :style="e.color ? { background: e.color } : undefined" />
              <span class="lr-name">{{ e.name }}</span>
              <span v-if="e.kind === 'group'" class="lr-tag">group</span>
              <span class="lr-stat">{{ e.services }}</span>
            </li>
          </ul>
        </li>
      </ul>
    </div>
  </aside>
</template>

<style scoped>
.layer-panel {
  position: absolute;
  top: 60px;
  right: 12px;
  width: 250px;
  max-height: calc(100% - 120px);
  display: flex;
  flex-direction: column;
  background: rgba(15, 19, 26, 0.88);
  border: 1px solid var(--sw-line-2);
  border-radius: 8px;
  backdrop-filter: blur(6px);
  /* High z so cientos <Html> labels (also DOM, portaled near the
     canvas) can't bleed over the chrome panels. */
  z-index: 50;
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--sw-line);
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sw-fg-2);
}
.panel-reset {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-2);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  cursor: pointer;
}
.panel-reset:hover { background: var(--sw-bg-3); color: var(--sw-fg-0); border-color: var(--sw-line-3); }
.panel-body {
  overflow-y: auto;
  flex: 1;
}
.grp-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
}
/* Fallback for admin-added custom level ids — listed first so the
   per-level selectors below win when their attribute matches. */
.grp-dot                            { background: var(--sw-fg-3); }
.grp-dot[data-plane='apps']         { background: var(--sw-accent); }
.grp-dot[data-plane='mesh']         { background: var(--sw-info); }
.grp-dot[data-plane='middleware']   { background: var(--sw-purple); }
.grp-dot[data-plane='infra']        { background: var(--sw-ok); }
.tier-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.tier-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  cursor: pointer;
  font-size: 11.5px;
  color: var(--sw-fg-1);
}
.tier-block { border-bottom: 1px solid var(--sw-line); }
.tier-block:last-child { border-bottom: none; }
.tier-block.hidden { opacity: 0.5; }
.tier-item:hover {
  background: rgba(255, 255, 255, 0.04);
  color: var(--sw-fg-0);
}
.layer-sublist { list-style: none; margin: 0; padding: 2px 0 6px; }
.layer-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 12px 4px 22px;
  cursor: pointer;
  font-size: 11px;
  color: var(--sw-fg-2);
}
.layer-row:hover { background: rgba(255, 255, 255, 0.04); color: var(--sw-fg-0); }
.layer-row.is-group .lr-name { font-weight: 700; }
.lr-dot { width: 7px; height: 7px; border-radius: 2px; flex: 0 0 7px; background: var(--sw-fg-3); }
.lr-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lr-tag {
  font-size: 8px; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--sw-accent-2); background: var(--sw-accent-soft);
  border-radius: 3px; padding: 0 4px;
}
.lr-stat { font-size: 9.5px; color: var(--sw-fg-3); font-variant-numeric: tabular-nums; }
.tier-name {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.tier-stat {
  font-size: 10px;
  color: var(--sw-fg-3);
  font-variant-numeric: tabular-nums;
  background: var(--sw-bg-3);
  border-radius: 3px;
  padding: 1px 6px;
}
.eye-btn {
  background: transparent;
  border: none;
  color: var(--sw-fg-3);
  width: 22px;
  height: 22px;
  padding: 0;
  border-radius: 3px;
  cursor: pointer;
  display: inline-grid;
  place-items: center;
  margin-left: 2px;
}
.eye-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--sw-fg-0);
}
</style>
