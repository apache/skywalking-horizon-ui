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
  Infra3DView — the /3d/map page chrome around the WebGL scene.

  Three planes (apps / service mesh / infra), each with per-layer
  colored zones. The side panel lists layers grouped by plane so the
  operator can toggle whole tiers or individual zones.
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useLayers } from '@/shell/useLayers';
import type { ServiceNamingRule } from '@skywalking-horizon-ui/api-client';
import Infra3DScene from './Infra3DScene.vue';
import Infra3DLayerPanel from './Infra3DLayerPanel.vue';
import PipelineTimeline from './PipelineTimeline.vue';
import type { MapTopology, SceneServiceNode } from './composables/useMapTopology';
import {
  zoneLayerKeys,
  type PlaneSpec,
  type PlanePlacement,
  type ZonePlacement,
} from './composables/useScenePlacement';
import logoSw from '@/assets/icons/logo-sw.svg?raw';
import { useInfra3dConfig } from './composables/useInfra3dConfig';
import { useInfra3dLoader } from './composables/useInfra3dLoader';

/** Imperative handle on the scene's camera-control methods. The
 *  top-left toolbar buttons go through this ref so the toolbar is
 *  decoupled from the WebGL plumbing — Scene owns the camera, View
 *  owns the chrome that drives it. */
interface SceneHandle {
  zoom: (factor: number) => void;
  rotateY: (degrees: number) => void;
  pan: (rightAmount: number, upAmount: number) => void;
  resetView: () => void;
  /** Reset the orbit to the default isometric orientation, then glide to
   *  FACE the target and zoom to fit `radius`. Used by the side panel. */
  focusOn: (target: { x: number; y: number; z: number }, radius: number) => void;
  /** Briefly flash the given layers' zone plates (light pulse, ~4s) to
   *  show which region a side-panel click selected. */
  flashZones: (layerKeys: string[]) => void;
}
const sceneRef = ref<SceneHandle | null>(null);

// Beacon mode — dims the whole scene to a dark wireframe and lets only
// alarming cubes glow, so the operator's eye goes straight to what's
// firing. Toggled from the toolbar; the scene reads it as a prop.
const beaconMode = ref(false);

const planes = ref<PlanePlacement[]>([]);
const zones = ref<ZonePlacement[]>([]);
const nodesByLayer = ref<Record<string, SceneServiceNode[]>>({});
const visibleLayers = ref<Set<string>>(new Set());
/** Where the orbit camera should look. Updated when the user selects
 *  a service node (recenters on the node) or clicks a layer label /
 *  side-panel row (recenters on the zone's center). The scene lerps
 *  toward this each frame so the camera glides rather than teleports. */
const focusTarget = ref<{ x: number; y: number; z: number } | null>(null);

// Single-layer focus mode: `/3d/map?layer=<key>` (linked from a layer's
// 2D Service Map) opens the existing 3D scene zoomed to ONE layer's
// internal topology — only that layer's cubes + its tier plane render,
// and the camera recenters on its zone. `null` ⇒ the full multi-tier map.
const route = useRoute();
const focusLayer = computed<string | null>(() => {
  const q = route.query.layer;
  return typeof q === 'string' && q.length > 0 ? q.toLowerCase() : null;
});
/** Plane to render solo in focus mode (the focused layer's tier). */
const soloPlane = ref<string | null>(null);

// Admin config gates the scene mount — the build-graph pass below is
// config-aware (level resolver, plane order, per-layer color) and
// running it before the config resolves would freeze the 3-plane
// fallback into the rendered layout. `ready` flips once the BFF /
// bundled defaults are in hand.
const { config: infraConfig, levelsOrdered, groups: infraGroups, ensureLoaded, levelForLayer, isLayerExcluded } = useInfra3dConfig();
const ready = ref(false);

// Per-layer topology-cluster rules (k8s/mesh namespace) from the live
// layer menu — drives the 3D namespace clustering, matching the 2D
// Service Map. Keyed upper-case to match the scene's lookup.
const { layers: menuLayers, isLoading: menuLoading } = useLayers();
const namingByLayer = computed<Record<string, ServiceNamingRule | null>>(() => {
  const out: Record<string, ServiceNamingRule | null> = {};
  for (const L of menuLayers.value) out[L.key.toUpperCase()] = L.naming ?? null;
  return out;
});
// Scene builds placement once at setup from namingByLayer; if the menu
// lands AFTER the mount gate, re-key so it rebuilds with the cluster rules.
const namingReady = computed(() => menuLayers.value.length > 0);
// Set when the config fetch rejects (OAP/BFF offline, or a role without
// `infra-3d:read`). Without this the page sat on "Loading…" forever —
// the operator couldn't tell a slow load from a hard failure.
const configError = ref<string | null>(null);

// Resolver + plane order are bound to the loaded config; both are
// passed into the Scene AND used to build the local placement copy
// the side panel needs for layer-focus.
const planeOrder = computed<PlaneSpec[]>(() =>
  (levelsOrdered.value ?? []).map((lvl) => ({ id: lvl.id, label: lvl.label })),
);


// The loading-stage registries + FULL / LIGHT run orchestration + the 60s
// auto-refresh timer live in useInfra3dLoader; it publishes `liveTopo` (the
// scene's render source) and the pipeline-timeline state.

// Live data is the default. `?live=0` forces the committed snapshot (a
// debug / comparison escape hatch). `liveTopo` (from the loader) holds the
// latest sequential assembly, published atomically once a run has the full
// structure so the scene renders complete (see sceneReady), never piecemeal.
const liveTopologyEnabled = computed(() => route.query.live !== '0');
const loader = useInfra3dLoader({
  infraConfig,
  levelsOrdered,
  infraGroups,
  levelForLayer,
  isLayerExcluded,
  menuLayers,
  planeOrder,
  liveTopologyEnabled,
});
const { liveTopo, nextRefreshAt, stages, stageOrder, pipelineRunning } = loader;

// Topology the scene renders. The scene builds its graph once at setup, so
// it is re-keyed on a STRUCTURE hash (per-layer service rosters + edge
// counts): a 60s refresh that finds the same structure leaves the key
// unchanged — no remount, so the camera and metric/alarm visuals persist —
// while a service appearing / disappearing rebuilds the scene.
const sceneTopology = computed<MapTopology | null>(() => {
  if (!liveTopologyEnabled.value) return null;
  const t = liveTopo.value;
  if (!t || Object.keys(t.servicesByLayer).length === 0) return null;
  return t;
});
const sceneKey = computed(() => {
  const naming = namingReady.value ? 'n' : '-';
  const t = sceneTopology.value;
  if (!t) return `${naming}:snapshot`;
  const struct = t.layers
    .map((L) => {
      const ids = (t.servicesByLayer[L.key] ?? []).map((s) => s.id).sort();
      const calls = t.topologies[L.key]?.calls.length ?? 0;
      return `${L.key}:${calls}:${ids.join(',')}`;
    })
    .join('|');
  // Hierarchy is built into the graph at scene setup, so fold a signature of
  // it into the key — otherwise a hierarchy change with the same roster +
  // call counts (e.g. a transiently-failed fetch succeeding on a later
  // refresh) wouldn't re-key and the new peers would never render.
  const hier = t.hierarchy
    .map((h) => `${h.fromLayer}/${h.fromService.id}:${h.peers.reduce((a, p) => a + p.services.length, 0)}`)
    .sort()
    .join(',');
  return `${naming}:${struct}#${hier}`;
});

// Render gate: in live mode hold the scene until the first full assembly
// lands so it appears complete, not piecemeal. Snapshot mode (?live=0) is
// ready immediately.
const sceneReady = computed(() => !liveTopologyEnabled.value || liveTopo.value !== null);

function onPlanes(p: PlanePlacement[]): void {
  planes.value = p;
}
/** Derive cube/plane visibility from the current zones + focus state.
 *  Focus mode (`?layer=`) shows only the one layer's cubes on its plane
 *  and recenters the camera on its zone — the existing scene scoped to a
 *  single layer's internal topology. A solo layer matches its own zone;
 *  a grouped layer matches the group zone that lists it. */
function applyVisibility(z: ZonePlacement[]): void {
  if (focusLayer.value) {
    const fz = z.find(
      (zz) =>
        zz.layerKey.toLowerCase() === focusLayer.value ||
        (zz.group?.layerKeys ?? []).some((k) => k.toLowerCase() === focusLayer.value),
    );
    if (fz) {
      visibleLayers.value = new Set([focusLayer.value]);
      soloPlane.value = fz.plane;
      focusTarget.value = { x: fz.centerX, y: fz.y + 0.5, z: fz.centerZ };
      return;
    }
    // Unknown layer in the URL → fall through to the full map.
  }
  // Default: every layer visible — group zones expand to their member
  // keys so the Scene's member-key gate lets the grouped cubes render.
  soloPlane.value = null;
  visibleLayers.value = new Set(z.flatMap(zoneLayerKeys));
}
function onZones(z: ZonePlacement[]): void {
  zones.value = z;
  applyVisibility(z);
}
// Re-derive visibility when the focus changes after mount (e.g. the
// "view full map" link flips `?layer` off) — no reload needed.
watch(focusLayer, () => applyVisibility(zones.value));
function onNodesByLayer(byLayer: Record<string, SceneServiceNode[]>): void {
  nodesByLayer.value = byLayer;
}
function togglePlane(planeId: string): void {
  const inPlane = zones.value.filter((z) => z.plane === planeId).flatMap(zoneLayerKeys);
  const allOn = inPlane.every((k) => visibleLayers.value.has(k));
  const next = new Set(visibleLayers.value);
  if (allOn) inPlane.forEach((k) => next.delete(k));
  else inPlane.forEach((k) => next.add(k));
  visibleLayers.value = next;
}

const hoveredNodeId = ref<string | null>(null);
const selectedNodeId = ref<string | null>(null);
function onHover(node: SceneServiceNode | null): void {
  hoveredNodeId.value = node?.nodeId ?? null;
}
/**
 * Selecting a service is decoupled from moving the camera. Operators
 * pick a cube to see its detail card; they move the orbit center via
 * the explicit affordances (side-panel row, toolbar buttons, arrow
 * keys / WASD). The detail card itself lives inside Infra3DScene as
 * a cientos <Html> anchored at the selected cube — this view just
 * tracks which node is selected.
 */
function onSelect(node: SceneServiceNode | null): void {
  if (!node || selectedNodeId.value === node.nodeId) {
    selectedNodeId.value = null;
  } else {
    selectedNodeId.value = node.nodeId;
  }
}
// The numeric scales are tuned to feel like one "step" of a typical
// scroll-zoom / drag-rotate, so each toolbar click is a chainable nudge.
function btnZoomIn(): void {
  sceneRef.value?.zoom(0.8);
}
function btnZoomOut(): void {
  sceneRef.value?.zoom(1.25);
}
function btnRotateLeft(): void {
  sceneRef.value?.rotateY(-15);
}
function btnRotateRight(): void {
  sceneRef.value?.rotateY(15);
}
function btnPan(rx: number, uy: number): void {
  sceneRef.value?.pan(rx, uy);
}
function btnReset(): void {
  sceneRef.value?.resetView();
  focusTarget.value = null;
  selectedNodeId.value = null;
}

// Arrow keys / WASD nudge the orbit center along the camera's
// screen-relative axes. Attached to `window` so the keys work without
// first clicking the canvas — input-focus is excluded below so future
// text inputs added to this view aren't hijacked.
function onKeyDown(e: KeyboardEvent): void {
  const tgt = e.target as HTMLElement | null;
  if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) {
    return;
  }
  if (e.altKey || e.metaKey || e.ctrlKey) return;
  let rx = 0;
  let uy = 0;
  switch (e.key) {
    case 'ArrowLeft':
    case 'a':
    case 'A':
      rx = -1;
      break;
    case 'ArrowRight':
    case 'd':
    case 'D':
      rx = 1;
      break;
    case 'ArrowUp':
    case 'w':
    case 'W':
      uy = 1;
      break;
    case 'ArrowDown':
    case 's':
    case 'S':
      uy = -1;
      break;
    case 'Escape':
      // Reliable deselect — independent of the canvas-click race, so
      // operators always have a guaranteed dismiss key even if
      // pointer-event ordering ever drifts.
      e.preventDefault();
      onSelect(null);
      return;
    default:
      return;
  }
  e.preventDefault();
  // Half-step pan by default; Shift = 3× for fast traverse.
  const factor = e.shiftKey ? 1.5 : 0.5;
  sceneRef.value?.pan(rx * factor, uy * factor);
}

// Standalone-mode lifecycle. This view lives at the top-level router
// path (`/3d/map`), OUTSIDE the AppShell, so there's no sidebar /
// topbar to coordinate with. The full viewport is ours — keyboard
// pan + arrow keys / WASD work without any chrome to fight.
onMounted(async () => {
  window.addEventListener('keydown', onKeyDown);
  // Fetch the admin config; gate scene mount on success. On failure
  // (offline / 401 from a role without infra-3d:read) surface the
  // reason instead of hanging on the load message — no broken-render
  // between 3-plane and 4-plane.
  try {
    await ensureLoaded();
  } catch (err) {
    configError.value = err instanceof Error ? err.message : String(err);
    return;
  }
  // Wait for the layer menu too — it carries the per-layer naming rules
  // that drive namespace clustering, and the scene reads them ONCE when
  // it builds placement. Bounded so a slow/unreachable menu just renders
  // the map unclustered rather than hanging on the loading state.
  await new Promise<void>((resolve) => {
    if (!menuLoading.value) return resolve();
    const stop = watch(menuLoading, (loading) => {
      if (!loading) { stop(); resolve(); }
    });
    setTimeout(() => { stop(); resolve(); }, 4000);
  });
  ready.value = true;
  // Full load once at landing (templates + layout + structure), then a
  // light refresh every minute (services + topologies + metrics). Alarms
  // poll on their own 1-min timer (20m window). The strip's refresh button
  // forces an immediate full run.
  loader.start();
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown);
  loader.stopRefresh();
});

/** Focus a tier (all its zones) — face + zoom the scene there and flash
 *  the region. Called from the side-panel tier row. */
function onPanelTierFocus(planeId: string): void {
  const inTier = zones.value.filter((z) => z.plane === planeId);
  if (inTier.length === 0) return;
  let sx = 0, sz = 0, halfW = 0, halfD = 0;
  for (const z of inTier) {
    sx += z.centerX;
    sz += z.centerZ;
    halfW = Math.max(halfW, Math.abs(z.centerX) + z.width / 2);
    halfD = Math.max(halfD, Math.abs(z.centerZ) + z.depth / 2);
  }
  const center = { x: sx / inTier.length, y: inTier[0]!.y + 0.5, z: sz / inTier.length };
  sceneRef.value?.focusOn(center, Math.max(halfW, halfD));
  sceneRef.value?.flashZones(inTier.flatMap(zoneLayerKeys));
}
/** Focus a single zone (layer / logic group) — face + zoom + flash. */
function onPanelZoneFocus(zoneKey: string): void {
  const z = zones.value.find((zz) => zz.layerKey === zoneKey);
  if (!z) return;
  sceneRef.value?.focusOn({ x: z.centerX, y: z.y + 0.5, z: z.centerZ }, Math.max(z.width, z.depth) / 2);
  sceneRef.value?.flashZones(zoneLayerKeys(z));
}

</script>

<template>
  <div class="infra3d">
    <header class="bar floating">
      <div class="title">
        <template v-if="focusLayer">
          <span class="kicker">3D Layer Topology</span>
          <span class="hint">
            focused on <strong>{{ focusLayer.toUpperCase() }}</strong> ·
            <router-link class="title-link" :to="{ path: '/3d/map' }">view full map</router-link>
            · drag to rotate · scroll to zoom
          </span>
        </template>
        <template v-else>
          <span class="kicker">3D Infrastructure Map</span>
          <span class="hint">apps · service mesh · middleware · infra · drag to rotate · scroll to zoom · arrow keys / WASD to pan</span>
        </template>
      </div>
      <div class="stats">
        <router-link class="back" to="/" title="Exit 3D map">×</router-link>
      </div>
    </header>

    <div class="canvas-shell">
      <div v-if="configError" class="cfg-error">
        <strong>Couldn’t load the 3D map.</strong>
        <span class="cfg-error__detail">{{ configError }}</span>
        <span class="cfg-error__hint">Check that OAP is reachable and your role has 3D Infra Map access (<code>infra-3d:read</code>).</span>
        <router-link class="cfg-error__back" to="/">← Back</router-link>
      </div>
      <div v-else-if="!ready" class="cfg-loading">Loading 3D map configuration…</div>
      <!-- Hold the render until the FULL context is in hand (layers,
           templates, services, topology, clustering) so the scene appears
           once, complete — never a partial layout that rebuilds as data
           lands. The bottom strip shows which stage is in flight. -->
      <div v-else-if="!sceneReady" class="cfg-loading">Reading topology from OAP…</div>
      <Infra3DScene
        v-else
        :key="sceneKey"
        ref="sceneRef"
        :plane-order="planeOrder"
        :topology="sceneTopology"
        :visible-layers="visibleLayers"
        :hovered-node-id="hoveredNodeId"
        :selected-node-id="selectedNodeId"
        :focus-target="focusTarget"
        :beacon-mode="beaconMode"
        :groups="infraGroups"
        :solo-plane="soloPlane"
        :naming-by-layer="namingByLayer"
        @hover="onHover"
        @select="onSelect"
        @planes="onPlanes"
        @zones="onZones"
        @nodes-by-layer="onNodesByLayer"
      />

      <!-- Explicit affordances for the same mouse rotate/zoom/pan
           gestures — useful on trackpads + as a discoverability cue. -->
      <aside v-if="sceneReady" class="cam-tools">
        <div class="cam-row">
          <button class="cam-btn" title="zoom in" @click="btnZoomIn">＋</button>
          <button class="cam-btn" title="zoom out" @click="btnZoomOut">−</button>
        </div>
        <div class="cam-row">
          <button class="cam-btn" title="rotate left" @click="btnRotateLeft">↺</button>
          <button class="cam-btn" title="rotate right" @click="btnRotateRight">↻</button>
        </div>
        <div class="cam-pad">
          <button class="cam-btn pad up" title="pan up" @click="btnPan(0, 1)">▲</button>
          <button class="cam-btn pad left" title="pan left" @click="btnPan(-1, 0)">◀</button>
          <button class="cam-btn pad reset" title="reset view" @click="btnReset">⌂</button>
          <button class="cam-btn pad right" title="pan right" @click="btnPan(1, 0)">▶</button>
          <button class="cam-btn pad down" title="pan down" @click="btnPan(0, -1)">▼</button>
        </div>
      </aside>

      <button
        v-if="sceneReady"
        class="beacon-toggle"
        :class="{ 'is-on': beaconMode }"
        :title="beaconMode ? 'Beacon mode on — click to show all' : 'Beacon mode — focus on alarms'"
        @click="beaconMode = !beaconMode"
      >
        <span class="beacon-dot" />
        <span class="beacon-label">Beacon</span>
      </button>

      <Infra3DLayerPanel
        v-if="sceneReady"
        :zones="zones"
        :nodes-by-layer="nodesByLayer"
        :visible-layers="visibleLayers"
        :levels-ordered="levelsOrdered"
        @tier-focus="onPanelTierFocus"
        @zone-focus="onPanelZoneFocus"
        @toggle-plane="togglePlane"
        @reset="btnReset"
      />

      <PipelineTimeline
        v-if="ready"
        class="pipeline-strip"
        :stages="stages"
        :stage-order="stageOrder"
        :running="pipelineRunning"
        :next-refresh-at="nextRefreshAt"
        @refresh="loader.refreshNow"
      />

      <!-- router-link, not a bare <a href="/">: a hardcoded "/" ignores
           the router base (import.meta.env.BASE_URL) and full-reloads to
           the server root, which lands on an empty page under a gateway
           sub-path. router-link prepends the base and stays in-SPA. -->
      <router-link class="sw-brand" to="/" title="Back to Horizon">
        <span class="sw-brand-logo" v-html="logoSw" />
        <span class="sw-brand-text">
          <span class="sw-brand-line1">Apache SkyWalking</span>
          <span class="sw-brand-line2">Horizon · 3D Infra Map</span>
        </span>
      </router-link>

    </div>
  </div>
</template>

<style scoped>
.infra3d {
  position: relative;
  width: 100vw;
  height: 100vh;
  min-height: 0;
  background: var(--sw-bg-0);
  overflow: hidden;
}
.bar.floating {
  position: absolute;
  top: 12px;
  left: 12px;
  right: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: rgba(15, 19, 26, 0.7);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  backdrop-filter: blur(8px);
  z-index: 40;
}
.title { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.kicker { font-weight: 700; font-size: 12.5px; letter-spacing: 0.03em; color: var(--sw-fg-0); }
.hint   { font-size: 10.5px; color: var(--sw-fg-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.title-link { color: var(--sw-accent); text-decoration: none; }
.title-link:hover { text-decoration: underline; }
.stats  { display: flex; align-items: center; gap: 12px; flex: 0 0 auto; }
.stat   { font-size: 11px; color: var(--sw-fg-2); }
.stat strong { color: var(--sw-fg-0); font-weight: 700; margin-right: 4px; }
.back {
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  background: transparent;
  color: var(--sw-fg-2);
  text-decoration: none;
  font-size: 16px;
  line-height: 1;
  transition: background 0.15s, color 0.15s;
}
.back:hover { background: var(--sw-bg-3); color: var(--sw-fg-0); }

.canvas-shell {
  position: absolute;
  inset: 0;
  overflow: hidden;
}

/* SkyWalking brand — bottom-left. Sits below the timeline (z 80) so the
   stage-detail drawer, which expands up over this corner, is not blocked.
   Subtle glass background so it reads on bright cube tints behind it. */
.sw-brand {
  position: absolute;
  left: 14px;
  bottom: 44px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px 5px 8px;
  background: rgba(15, 19, 26, 0.72);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
  text-decoration: none;
  color: var(--sw-fg-0);
  backdrop-filter: blur(6px);
  z-index: 70;
  transition: background 0.15s;
}
.sw-brand:hover { background: rgba(15, 19, 26, 0.88); }
.sw-brand-logo {
  display: inline-flex;
  align-items: center;
}
.sw-brand-logo :deep(svg) { width: auto; height: 18px; display: block; }
.sw-brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
}
.sw-brand-line1 {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: var(--sw-fg-0);
}
.sw-brand-line2 {
  font-size: 9.5px;
  color: var(--sw-fg-3);
  letter-spacing: 0.04em;
}
.cfg-loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 12px;
  letter-spacing: 0.02em;
  color: var(--sw-fg-3);
}
.cfg-error {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  font-size: 12px;
  color: var(--sw-fg-1);
}
.cfg-error strong { color: var(--sw-err); font-size: 13px; }
.cfg-error__detail { color: var(--sw-fg-2); font-family: var(--sw-font-mono, monospace); font-size: 11px; }
.cfg-error__hint { color: var(--sw-fg-3); max-width: 420px; line-height: 1.5; }
.cfg-error__back { margin-top: 6px; color: var(--sw-accent); text-decoration: none; }
.cfg-error__back:hover { text-decoration: underline; }
.pipeline-strip {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
}


.cam-tools {
  position: absolute;
  top: 60px;
  left: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  background: rgba(15, 19, 26, 0.88);
  border: 1px solid var(--sw-line-2);
  border-radius: 8px;
  backdrop-filter: blur(6px);
  /* High z so cientos <Html> labels (also DOM, portaled near the
     canvas) can't bleed over the chrome panels. */
  z-index: 50;
}
.cam-row {
  display: flex;
  gap: 4px;
}
.beacon-toggle {
  position: absolute;
  top: 256px;
  left: 12px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 11px;
  background: rgba(15, 19, 26, 0.88);
  border: 1px solid var(--sw-line-2);
  border-radius: 8px;
  backdrop-filter: blur(6px);
  color: var(--sw-fg-2);
  font-size: 11px;
  letter-spacing: 0.04em;
  cursor: pointer;
  z-index: 50;
  transition: border-color 0.15s, color 0.15s;
}
.beacon-toggle:hover { color: var(--sw-fg-0); border-color: var(--sw-line); }
.beacon-toggle.is-on { border-color: #ef4444; color: #fca5a5; }
.beacon-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--sw-fg-3); }
.beacon-toggle.is-on .beacon-dot {
  background: #ef4444;
  box-shadow: 0 0 8px 1px rgba(239, 68, 68, 0.8);
  animation: beacon-pulse 1.4s infinite ease-in-out;
}
@keyframes beacon-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
.cam-pad {
  display: grid;
  grid-template-columns: repeat(3, 26px);
  grid-template-rows: repeat(3, 26px);
  gap: 2px;
  margin-top: 2px;
}
.cam-pad .up    { grid-column: 2; grid-row: 1; }
.cam-pad .left  { grid-column: 1; grid-row: 2; }
.cam-pad .reset { grid-column: 2; grid-row: 2; }
.cam-pad .right { grid-column: 3; grid-row: 2; }
.cam-pad .down  { grid-column: 2; grid-row: 3; }
.cam-btn {
  width: 26px;
  height: 26px;
  display: inline-grid;
  place-items: center;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-1);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  user-select: none;
  padding: 0;
}
.cam-btn:hover {
  background: var(--sw-bg-3);
  border-color: var(--sw-line-3);
  color: var(--sw-fg-0);
}
.cam-btn:active { transform: translateY(1px); }
.cam-btn.pad.reset {
  color: var(--sw-accent-2);
  border-color: var(--sw-accent-line);
}
</style>
