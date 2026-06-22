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
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useLayers } from '@/shell/useLayers';
import type { ServiceNamingRule } from '@skywalking-horizon-ui/api-client';
import Infra3DScene from './Infra3DScene.vue';
import PipelineTimeline from './PipelineTimeline.vue';
import {
  buildSceneGraph,
  loadFallbackTopology,
  type MapTopology,
  type MapHierarchyEntry,
  type SceneServiceNode,
} from './composables/useMapTopology';
import {
  computePlacement,
  type PlaneSpec,
  type PlanePlacement,
  type ZonePlacement,
} from './composables/useScenePlacement';
import logoSw from '@/assets/icons/logo-sw.svg?raw';
import { useInfra3dConfig } from './composables/useInfra3dConfig';
import { useInfra3dPipeline, type PipelineStageId, type StageImpl } from './composables/useInfra3dPipeline';
import { setValues as setMetricValues, setUnitForLayer, reset as resetMetrics } from './composables/useInfra3dMetrics';
import {
  isTopologyBearing,
  liveRoster,
  liveSkeleton,
  loadLiveServices,
  loadLiveTopologies,
  loadLiveHierarchy,
  type LiveWindow,
} from './composables/useLiveTopology';
import { bff, type Infra3dConfig } from '@/api/client';

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
// Auto-refresh: re-run the pipeline every REFRESH_MS. A self-rescheduling
// timeout (not setInterval) so a manual refresh resets the countdown
// cleanly instead of drifting against a fixed interval. `nextRefreshAt`
// (epoch ms) feeds the timeline strip's live countdown. Cleared on unmount.
const REFRESH_MS = 60_000;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
const nextRefreshAt = ref<number | null>(null);

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


// ── Loading pipeline ─────────────────────────────────────────────────
// Five-stage state machine fed by the existing static demo topology
// today; stage 5 (metrics) is a stub awaiting the live MQE wire-up.
// The timeline strip subscribes to the same shared state so the
// operator sees stage transitions as they happen.
const { stages, stageOrder, running: pipelineRunning, run: runPipelineState } = useInfra3dPipeline();

interface PipelineCtx {
  servicesByLayer: Record<string, SceneServiceNode[]>;
  /** Live path only: the MapTopology assembled as stages land. The
   *  snapshot impls leave it null and read loadFallbackTopology() directly. */
  topo: MapTopology | null;
}

// Live data is the default. `?live=0` forces the committed snapshot (a
// debug / comparison escape hatch). `liveTopo` holds the latest sequential
// assembly, published atomically once a run has the full structure so the
// scene renders complete (see sceneReady), never piecemeal.
const liveTopologyEnabled = computed(() => route.query.live !== '0');
const liveTopo = shallowRef<MapTopology | null>(null);
const liveWindow = (): LiveWindow => ({
  startMs: Date.now() - 2 * 3600_000,
  endMs: Date.now(),
  step: 'HOUR',
});

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

// Refresh modes. Landing + manual refresh run the FULL pipeline (templates
// + layout/clustering resolve here, once). The 60s auto-refresh runs LIGHT
// — services + topologies + metrics only — reusing templates/layout from
// the last full run. `knownLayers` is the template set captured at the last
// full run; a layer that appears only on a light refresh has no template,
// so its services are hidden until the next full (manual / page) refresh.
type PipelineMode = 'full' | 'light';
const pipelineMode = ref<PipelineMode>('full');
const knownLayers = shallowRef<Set<string> | null>(null);
// Cross-layer hierarchy cache (LAYER::serviceId → entry | null), persisted
// across refreshes. The hierarchy stage fetches ONLY services missing from
// here and reuses the rest, so a steady roster costs zero OAP calls; a
// `null` records "checked, no peers" so it isn't re-probed.
const hierarchyCache = new Map<string, MapHierarchyEntry | null>();

// SceneServiceNode view of a MapTopology — what the metrics stage and the
// scene's node grid consume. shortName = last `::` segment, pre-dot.
function sceneNodesFrom(topo: MapTopology): Record<string, SceneServiceNode[]> {
  const byLayer: Record<string, SceneServiceNode[]> = {};
  for (const [key, refs] of Object.entries(topo.servicesByLayer)) {
    byLayer[key] = refs.map((s) => ({
      nodeId: `${key.toUpperCase()}::${s.id}`,
      layerKey: key,
      serviceId: s.id,
      name: s.name,
      shortName: s.name.split('::').slice(-1)[0]!.split('.')[0]!,
      normal: s.normal,
    }));
  }
  return byLayer;
}

const pipelineImpls: Record<PipelineStageId, StageImpl<PipelineCtx>> = {
  services: async (rep, ctx) => {
    rep.start();
    const topo = loadFallbackTopology();
    const byLayer: Record<string, SceneServiceNode[]> = {};
    let total = 0;
    for (const L of topo.layers) {
      const list = (topo.servicesByLayer[L.key] ?? []).map((s) => ({
        nodeId: `${L.key.toUpperCase()}::${s.id}`,
        layerKey: L.key,
        serviceId: s.id,
        name: s.name,
        shortName: s.name.split('::').slice(-1)[0]!.split('.')[0]!,
        normal: s.normal,
      }));
      if (list.length > 0) byLayer[L.key] = list;
      total += list.length;
    }
    ctx.servicesByLayer = byLayer;
    rep.ok(`${total} services / ${Object.keys(byLayer).length} layers`, {
      kind: 'services',
      servicesTotal: total,
      layersTotal: Object.keys(byLayer).length,
      addedSince: null,
      removedSince: null,
    });
  },
  templates: async (rep, _ctx) => {
    rep.start();
    const topo = loadFallbackTopology();
    const withTopology: string[] = [];
    const withoutTopology: string[] = [];
    for (const L of topo.layers) {
      const t = topo.topologies?.[L.key];
      if (t && t.calls.length > 0) withTopology.push(L.key);
      else withoutTopology.push(L.key);
    }
    rep.ok(`${withTopology.length} topology-bearing`, {
      kind: 'templates',
      layersWithTopology: withTopology,
      layersWithoutTopology: withoutTopology,
    });
  },
  topologies: async (rep, _ctx) => {
    rep.start();
    const topo = loadFallbackTopology();
    const probes = Object.entries(topo.topologies ?? {}).map(([layerKey, t]) => ({
      layerKey,
      status: (t.calls.length > 0 ? 'ok' : 'empty') as 'ok' | 'empty',
      ms: 0,
      nodeCount: t.nodes.length,
      edgeCount: t.calls.length,
    }));
    rep.ok(`${probes.filter((p) => p.status === 'ok').length} maps with edges`, {
      kind: 'topologies',
      probes,
    });
  },
  hierarchy: async (rep, _ctx) => {
    // Snapshot mode already ships the cross-layer hierarchy in the bundled
    // topology — nothing to fetch; just report what it carries.
    rep.start();
    const topo = loadFallbackTopology();
    const peers = topo.hierarchy.reduce((a, h) => a + h.peers.reduce((b, p) => b + p.services.length, 0), 0);
    rep.ok(`${topo.hierarchy.length} cross-layer links`, {
      kind: 'hierarchy',
      servicesTotal: topo.hierarchy.length,
      fetched: 0,
      reused: topo.hierarchy.length,
      links: peers,
    });
  },
  layout: async (rep, _ctx) => {
    rep.start();
    const t0 = performance.now();
    // The scene rebuilds placement on its own; we just measure the cost.
    const topo = loadFallbackTopology();
    const g = buildSceneGraph(topo, levelForLayer, isLayerExcluded);
    // Pass groups so the measured zone count matches the rendered scene
    // (Infra3DScene collapses each logic group into one zone).
    const p = computePlacement(g, planeOrder.value, infraGroups.value);
    const ms = Math.round(performance.now() - t0);
    rep.ok(`${p.zones.length} zones laid in ${ms} ms`, {
      kind: 'layout',
      layersReLaid: p.zones.length,
      ms,
    });
  },
  metrics: async (rep, ctx) => {
    rep.start();
    resetMetrics();
    const cfg = infraConfig.value as Infra3dConfig | null;
    if (!cfg) {
      rep.warn('config not loaded', {
        kind: 'metrics', servicesTotal: 0, servicesDone: 0,
        chunkIndex: 0, chunkTotal: 0, currentLevel: null,
      });
      return;
    }
    const chunkSize = Math.max(1, cfg.pipeline.metricChunkSize);

    // Resolve each service to its (mqe, layer, normal) via the single
    // `metric` (canonical), falling back to the deprecated topology/load
    // shapes for older saved rows. Services whose layer has no MQE
    // configured are skipped — their cube renders without a chip.
    interface FetchUnit { name: string; layer: string; normal: boolean; mqe: string; nodeKey: string }
    const units: FetchUnit[] = [];
    for (const [layerKey, nodes] of Object.entries(ctx.servicesByLayer)) {
      const upperLayer = layerKey.toUpperCase();
      const spec = cfg.layers[upperLayer];
      if (!spec) continue;
      const mqe = spec.metric ?? spec.topology?.server ?? spec.topology?.client ?? spec.load ?? null;
      if (!mqe) continue;
      setUnitForLayer(upperLayer, mqe.unit);
      for (const n of nodes) {
        units.push({
          name: n.name,
          layer: upperLayer,
          normal: n.normal,
          mqe: mqe.mqe,
          nodeKey: `${upperLayer}::${n.name}`,
        });
      }
    }

    if (units.length === 0) {
      rep.ok('no services with a configured MQE', {
        kind: 'metrics', servicesTotal: 0, servicesDone: 0,
        chunkIndex: 0, chunkTotal: 0, currentLevel: null,
      });
      return;
    }

    // Group chunks by level so the drawer can label the in-flight
    // batch with the level the operator is watching land. Within a
    // level, slice by chunkSize; chunks then run in bounded-concurrency
    // groups (below), with progress reported as each chunk lands.
    const byLevel = new Map<string, FetchUnit[]>();
    for (const u of units) {
      const lvl = levelForLayer(u.layer);
      const arr = byLevel.get(lvl) ?? [];
      arr.push(u);
      byLevel.set(lvl, arr);
    }
    // Walk levels top-down so the most-visible cubes light up first.
    const levelOrder = (levelsOrdered.value ?? []).map((l) => l.id);
    const chunks: { level: string; units: FetchUnit[] }[] = [];
    for (const lvlId of levelOrder) {
      const lvlUnits = byLevel.get(lvlId) ?? [];
      for (let i = 0; i < lvlUnits.length; i += chunkSize) {
        chunks.push({ level: lvlId, units: lvlUnits.slice(i, i + chunkSize) });
      }
    }
    // Catch any unknown-level units that fell outside the ordered list.
    for (const [lvlId, lvlUnits] of byLevel) {
      if (levelOrder.includes(lvlId)) continue;
      for (let i = 0; i < lvlUnits.length; i += chunkSize) {
        chunks.push({ level: lvlId, units: lvlUnits.slice(i, i + chunkSize) });
      }
    }

    // Fan chunks out in bounded-concurrency groups (each request is still
    // ≤ metricChunkSize services, so OAP's per-request budget is unchanged).
    const metricConcurrency = Math.max(1, Math.min(8, cfg.pipeline.metricConcurrency ?? 4));
    // Two HOUR buckets — cheapest query that still smooths a spiky minute.
    const metricWindow = { startMs: Date.now() - 2 * 3600_000, endMs: Date.now(), step: 'HOUR' as const };
    let servicesDone = 0;
    let errCount = 0;
    let chunksDone = 0;
    rep.progress(`fetching metrics · 0 / ${chunks.length} chunks`, {
      kind: 'metrics',
      servicesTotal: units.length,
      servicesDone: 0,
      chunkIndex: 0,
      chunkTotal: chunks.length,
      currentLevel: chunks[0]?.level ?? null,
    });
    const runChunk = async (chunk: { level: string; units: FetchUnit[] }) => {
      try {
        const r = await bff.infra3d.metrics({
          services: chunk.units.map((u) => ({
            name: u.name, layer: u.layer, normal: u.normal, mqe: u.mqe,
          })),
          window: metricWindow,
        });
        setMetricValues(r.values);
        if (r.errors && Object.keys(r.errors).length > 0) errCount += Object.keys(r.errors).length;
      } catch (err) {
        errCount += chunk.units.length;
        // Whole-chunk failure → mark every node in the chunk null.
        const fallback: Record<string, number | null> = {};
        for (const u of chunk.units) fallback[u.nodeKey] = null;
        setMetricValues(fallback);
        console.warn('[infra-3d] metrics chunk failed:', err);
      }
      servicesDone += chunk.units.length;
      chunksDone += 1;
      rep.progress(`fetching ${chunk.level} · ${chunksDone} / ${chunks.length} chunks`, {
        kind: 'metrics',
        servicesTotal: units.length,
        servicesDone,
        chunkIndex: chunksDone,
        chunkTotal: chunks.length,
        currentLevel: chunk.level,
      });
    };
    for (let g = 0; g < chunks.length; g += metricConcurrency) {
      await Promise.all(chunks.slice(g, g + metricConcurrency).map(runChunk));
    }

    const summary = errCount === 0
      ? `${servicesDone} / ${units.length} services updated`
      : `${servicesDone} updated · ${errCount} OAP errors`;
    const finalDetail = {
      kind: 'metrics' as const,
      servicesTotal: units.length,
      servicesDone,
      chunkIndex: chunks.length,
      chunkTotal: chunks.length,
      currentLevel: null,
    };
    if (errCount === 0) rep.ok(summary, finalDetail);
    else rep.warn(summary, finalDetail);
  },
};

// Live variant of the pipeline: `services` / `topologies` read from
// sequential per-layer OAP queries (assembled into a MapTopology); the
// `liveTopo` ref is published atomically at the END of `topologies`, so the
// scene renders the full structure once. `templates` / `layout` resolve
// once per FULL run (skipped on light auto-refresh). `metrics` is shared.
const livePipelineImpls: Record<PipelineStageId, StageImpl<PipelineCtx>> = {
  services: async (rep, ctx) => {
    // Drop globally-filtered layers up front — `filter.layer` puts them OFF
    // the map, so the pipeline must not spend services / topology / hierarchy
    // / metric OAP calls on them. Everything downstream derives from `roster`.
    const roster = liveRoster(menuLayers.value).filter((L) => !isLayerExcluded(L.key));
    const known = knownLayers.value;
    const light = pipelineMode.value === 'light' && known !== null;
    // Light refresh renders only layers known at the last full load. A layer
    // that appeared since has no template — hide its services until the next
    // full (manual / page) refresh, and surface it in the stage detail.
    const active = light ? roster.filter((L) => known!.has(L.key)) : roster;
    const hidden = light ? roster.filter((L) => !known!.has(L.key)).map((L) => L.key) : [];
    const topo = liveSkeleton(active);
    await loadLiveServices(rep, active, topo, hidden);
    ctx.topo = topo;
    ctx.servicesByLayer = sceneNodesFrom(topo);
  },
  templates: async (rep, ctx) => {
    rep.start();
    const rosterKeys = (ctx.topo?.layers ?? []).map((l) => l.key);
    // The template set — captured once per full run. Light refreshes hide
    // any layer outside it (no template loaded for it yet).
    knownLayers.value = new Set(rosterKeys);
    const withTopology = menuLayers.value
      .filter((L) => knownLayers.value!.has(L.key) && isTopologyBearing(L))
      .map((L) => L.key);
    const withoutTopology = rosterKeys.filter((k) => !withTopology.includes(k));
    rep.ok(`${withTopology.length} topology-bearing`, {
      kind: 'templates',
      layersWithTopology: withTopology,
      layersWithoutTopology: withoutTopology,
    });
  },
  topologies: async (rep, ctx) => {
    const topo = ctx.topo;
    if (!topo) {
      rep.ok('no topology', { kind: 'topologies', probes: [] });
      return;
    }
    const rosterKeys = new Set(topo.layers.map((l) => l.key));
    const bearing = menuLayers.value.filter((L) => rosterKeys.has(L.key) && isTopologyBearing(L));
    await loadLiveTopologies(rep, bearing, topo, liveWindow());
  },
  hierarchy: async (rep, ctx) => {
    const topo = ctx.topo;
    if (!topo) {
      rep.ok('no services', { kind: 'hierarchy', servicesTotal: 0, fetched: 0, reused: 0, links: 0 });
      return;
    }
    try {
      await loadLiveHierarchy(rep, topo, hierarchyCache);
    } finally {
      // Publish the assembled structure (services + topology + whatever
      // hierarchy landed) in one shot. In `finally` so a hierarchy fault
      // degrades to "no peer tubes" rather than blanking the whole map —
      // the base structure is already complete and independent of hierarchy.
      // `sceneKey` folds in a hierarchy signature, so a later refresh that
      // fills it in re-keys and the tubes appear.
      liveTopo.value = topo;
    }
  },
  layout: async (rep, ctx) => {
    rep.start();
    const t0 = performance.now();
    const g = buildSceneGraph(ctx.topo ?? loadFallbackTopology(), levelForLayer, isLayerExcluded);
    const p = computePlacement(g, planeOrder.value, infraGroups.value);
    const ms = Math.round(performance.now() - t0);
    rep.ok(`${p.zones.length} zones laid in ${ms} ms`, {
      kind: 'layout',
      layersReLaid: p.zones.length,
      ms,
    });
  },
  // Shared with the snapshot pipeline: it reads ctx.servicesByLayer, which
  // both services stages populate with the same SceneServiceNode[] shape.
  metrics: pipelineImpls.metrics,
};

// FULL run — landing + manual refresh. Resolves templates + layout/clustering
// and captures the known-layer set.
async function runFull(): Promise<void> {
  pipelineMode.value = 'full';
  const ctx: PipelineCtx = { servicesByLayer: {}, topo: null };
  await runPipelineState(ctx, liveTopologyEnabled.value ? livePipelineImpls : pipelineImpls);
}

// LIGHT run — the 60s auto-refresh. Re-reads services + topologies + metrics
// only; templates + layout keep their last full-run state in the strip.
// Snapshot mode (?live=0) has no cheaper path, so it re-runs the full
// in-memory pipeline.
async function runLight(): Promise<void> {
  if (!liveTopologyEnabled.value) return runFull();
  pipelineMode.value = 'light';
  const ctx: PipelineCtx = { servicesByLayer: {}, topo: null };
  await runPipelineState(ctx, livePipelineImpls, ['services', 'topologies', 'hierarchy', 'metrics']);
}


/** Arm (or re-arm) the auto-refresh timer + countdown anchor. */
function scheduleRefresh(): void {
  if (refreshTimer !== null) clearTimeout(refreshTimer);
  nextRefreshAt.value = Date.now() + REFRESH_MS;
  refreshTimer = setTimeout(() => {
    void runLight();
    scheduleRefresh();
  }, REFRESH_MS);
}

/** Manual refresh from the timeline strip — a FULL reload (re-checks
 *  templates + layout) and resets the countdown. */
function refreshNow(): void {
  void runFull();
  scheduleRefresh();
}

function onPlanes(p: PlanePlacement[]): void {
  planes.value = p;
}
/** Expand a zone to the layer key(s) the Scene gates visibility on. A
 *  solo zone keys on its own layer; a GROUP zone (e.g. Self-Observability
 *  clustering so11y_*) keys on its MEMBER layers. The Scene checks
 *  `visibleNodes` / `visibleZones` against member layer keys, never the
 *  group id — so visibility seeding, the tier toggle, and per-layer
 *  counts must all use the members. Keying on the group id alone leaves
 *  grouped cubes unrendered and undercounts the tier. */
function zoneLayerKeys(z: ZonePlacement): string[] {
  return z.group ? z.group.layerKeys : [z.layerKey];
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
/** "all" → every layer in this tier is on; "none" → every layer is
 *  off; "some" → mixed. Drives the eye-toggle icon state and the
 *  hidden-row class on the tier row. */
function tierVisibility(tierZones: ZonePlacement[]): 'all' | 'some' | 'none' {
  const keys = tierZones.flatMap(zoneLayerKeys);
  if (keys.length === 0) return 'none';
  let on = 0;
  for (const k of keys) if (visibleLayers.value.has(k)) on++;
  if (on === 0) return 'none';
  if (on === keys.length) return 'all';
  return 'some';
}
function visibleServicesInTier(tierZones: ZonePlacement[]): number {
  let n = 0;
  for (const k of tierZones.flatMap(zoneLayerKeys)) {
    if (!visibleLayers.value.has(k)) continue;
    n += (nodesByLayer.value[k] || []).length;
  }
  return n;
}
function totalServicesInTier(tierZones: ZonePlacement[]): number {
  let n = 0;
  for (const k of tierZones.flatMap(zoneLayerKeys)) n += (nodesByLayer.value[k] || []).length;
  return n;
}

// ── Camera toolbar handlers — straight pass-through to the scene
//    handle. The numeric scales are tuned to feel like one "step" of
//    a typical scroll-zoom / drag-rotate, so each click is a small
//    nudge an operator can chain. ─────────────────────────────────────
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

// ── Keyboard pan ─────────────────────────────────────────────────────
// Arrow keys nudge the orbit center along the camera's screen-relative
// axes (up = pan up, left = pan left, …). Holding the key auto-repeats
// via the browser's native keydown repeat. WASD aliases the same
// gestures so a gamer-style operator can drive the scene without
// reaching for the arrow cluster.
//
// We attach to `window` so the keys work without first clicking the
// canvas — but only suppress the default when the focus isn't on a
// text input (the side panel doesn't have any, so this is just defence
// against future inputs added to this view).
function onKeyDown(e: KeyboardEvent): void {
  const tgt = e.target as HTMLElement | null;
  // Don't hijack typing if the operator happens to be in an input.
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
  void runFull();
  scheduleRefresh();
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKeyDown);
  if (refreshTimer !== null) clearTimeout(refreshTimer);
});

// Group zones by plane for the side panel — order matches `levels`
// from the admin config (apps on top, infra at the bottom by default).
function servicesIn(key: string): number {
  return nodesByLayer.value[key]?.length ?? 0;
}

interface PanelEntry {
  kind: 'layer' | 'group';
  key: string;
  name: string;
  color?: string;
  services: number;
}
/** Side-panel hierarchy: tier → layer | logic-group (2 levels). */
const panelTree = computed(() =>
  (levelsOrdered.value ?? []).map((lvl) => {
    const tierZones = zones.value.filter((z) => z.plane === lvl.id);
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
    <!-- Floating top bar — sits above the scene rather than taking
         vertical space, so the WebGL canvas gets the full viewport.
         Compact and unobtrusive; the operator's eye lands on the
         scene first, the chrome is glanceable when they need stats. -->
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
      <!-- Counts + query-scope live in the bottom status strip; the
           header keeps only the title and the exit affordance. -->
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

      <!-- Top-left camera-control toolbar. Mouse rotate/zoom/pan still
           work; these buttons give explicit affordances for the same
           gestures (useful on trackpads + as a discoverability cue). -->
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

      <!-- Beacon mode toggle — dims the scene to wireframe so only
           alarming cubes stand out. Sits under the camera toolbar. -->
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

      <!-- Side panel: tier → layer/logic-group. Click focuses + flashes
           that region; the eye toggles the tier. -->
      <aside v-if="sceneReady" class="layer-panel">
        <div class="panel-head">
          <span>Tiers</span>
          <button type="button" class="panel-reset" title="Reset the view to the default framing" @click="btnReset">⌂ Reset</button>
        </div>
        <div class="panel-body">
          <ul class="tier-list">
            <li
              v-for="g in panelTree"
              :key="g.id"
              class="tier-block"
              :class="{ hidden: tierVisibility(g.zones) === 'none' }"
            >
              <!-- Tier row — click to focus the tier, eye to toggle it. -->
              <div class="tier-item" @click="onPanelTierFocus(g.id)">
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
                  @click.stop="togglePlane(g.id)"
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

              <!-- Layers + logic groups on this tier (level 2). -->
              <ul v-if="g.entries.length" class="layer-sublist">
                <li
                  v-for="e in g.entries"
                  :key="e.key"
                  class="layer-row"
                  :class="{ 'is-group': e.kind === 'group' }"
                  :title="`Focus ${e.name}`"
                  @click="onPanelZoneFocus(e.key)"
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

      <PipelineTimeline
        v-if="ready"
        class="pipeline-strip"
        :stages="stages"
        :stage-order="stageOrder"
        :running="pipelineRunning"
        :next-refresh-at="nextRefreshAt"
        @refresh="refreshNow"
      />

      <!-- Bottom-left brand mark — anchors the standalone view to the
           SkyWalking product identity. No link / no chrome; pure
           identification so an operator opening the page mid-incident
           still knows where they are. -->
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
/* Floating top bar — overlays the canvas so the scene gets the full
   viewport. Compact, glass-backed, with a small × that returns the
   operator to the rest of Horizon. */
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
.grp {
  border-bottom: 1px solid var(--sw-line);
}
.grp:last-child {
  border-bottom: none;
}
.grp-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  cursor: pointer;
  font-size: 10.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-1);
}
.grp-head:hover {
  background: rgba(255, 255, 255, 0.03);
  color: var(--sw-fg-0);
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
.grp-name { flex: 1; min-width: 0; }
.grp-count {
  font-size: 9.5px;
  background: var(--sw-bg-3);
  border-radius: 3px;
  padding: 1px 5px;
  color: var(--sw-fg-1);
  font-weight: 600;
  letter-spacing: 0;
}
/* Tier-list — replaces the legacy nested grp-head + layer-list. One
   row per tier (apps / mesh / middleware / infra in the bundled
   config); click the row to fly the camera to the tier, click the
   eye to hide / show every layer in that tier at once. */
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
/* ── Nested hierarchy: layers / logic groups under a tier, members /
      clusters under those. Indented, lighter than the tier row. ── */
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

.layer-list {
  list-style: none;
  margin: 0;
  padding: 0 0 4px;
}
.layer-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px 4px 22px;
  cursor: pointer;
  font-size: 11.5px;
  color: var(--sw-fg-1);
}
.layer-item:hover {
  background: rgba(255, 255, 255, 0.04);
  color: var(--sw-fg-0);
}
.layer-item.hidden {
  opacity: 0.4;
}
.layer-item.hidden .swatch { opacity: 0.3; }
.swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  flex: 0 0 10px;
}
.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.count {
  background: var(--sw-bg-3);
  border-radius: 3px;
  padding: 1px 5px;
  color: var(--sw-fg-1);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
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
.layer-item.hidden .eye-btn { color: var(--sw-fg-3); }
.layer-item:not(.hidden) .eye-btn[aria-pressed='true'] { color: var(--sw-fg-1); }
.layer-item.topo .name {
  color: var(--sw-fg-0);
  font-weight: 600;
}

/* Detail card moved INTO the Scene component as a cientos <Html>
   anchored at the selected cube — its styles now live alongside the
   floating tooltip in Infra3DScene.vue's non-scoped style block. */

/* ── Top-left camera toolbar ─────────────────────────────────────── */
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
