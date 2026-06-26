/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Loading orchestration for the 3D Infrastructure Map.
 *
 * Owns the two stage-impl registries (snapshot + live), the FULL / LIGHT
 * run orchestration, and the self-rescheduling 60s auto-refresh timer. The
 * view binds the scene topology + the timeline strip to the reactive state
 * this returns; the timer is torn down on unmount via `stopRefresh()`.
 *
 *   - FULL run (landing + manual refresh): resolves templates + layout /
 *     clustering and captures the known-layer set.
 *   - LIGHT run (60s auto-refresh): re-reads services + topologies + metrics
 *     only, reusing templates / layout from the last full run.
 *
 * Live data is the default; `?live=0` forces the committed snapshot.
 */
import { shallowRef, type ComputedRef, type Ref } from 'vue';
import type { LayerDef } from '@skywalking-horizon-ui/api-client';
import { bff, type Infra3dConfig } from '@/api/client';
import type { useInfra3dConfig } from './useInfra3dConfig';
import {
  buildSceneGraph,
  loadFallbackTopology,
  type MapTopology,
  type MapHierarchyEntry,
  type SceneServiceNode,
} from './useMapTopology';
import { computePlacement, type PlaneSpec } from './useScenePlacement';
import { useInfra3dPipeline, type PipelineStageId, type StageImpl } from './useInfra3dPipeline';
import { setValues as setMetricValues, setUnitForLayer, reset as resetMetrics } from './useInfra3dMetrics';
import {
  isTopologyBearing,
  liveRoster,
  liveSkeleton,
  loadLiveServices,
  loadLiveTopologies,
  loadLiveHierarchy,
  type LiveWindow,
} from './useLiveTopology';

type Infra3dConfigApi = ReturnType<typeof useInfra3dConfig>;

interface PipelineCtx {
  servicesByLayer: Record<string, SceneServiceNode[]>;
  /** Live path only: the MapTopology assembled as stages land. The
   *  snapshot impls leave it null and read loadFallbackTopology() directly. */
  topo: MapTopology | null;
}

const REFRESH_MS = 60_000;

/** What the view supplies — the config-derived helpers + the live layer
 *  menu the pipeline reads. The loader owns everything else (topology
 *  publication, refresh modes, the timer). */
export interface Infra3dLoaderDeps {
  infraConfig: Infra3dConfigApi['config'];
  levelsOrdered: Infra3dConfigApi['levelsOrdered'];
  infraGroups: Infra3dConfigApi['groups'];
  levelForLayer: Infra3dConfigApi['levelForLayer'];
  isLayerExcluded: Infra3dConfigApi['isLayerExcluded'];
  menuLayers: Ref<LayerDef[]> | ComputedRef<LayerDef[]>;
  planeOrder: ComputedRef<PlaneSpec[]>;
  /** `route.query.live !== '0'` — live data unless the snapshot is forced. */
  liveTopologyEnabled: ComputedRef<boolean>;
}

export interface Infra3dLoader {
  /** Latest sequential assembly, published atomically once a run has the
   *  full structure so the scene renders complete, never piecemeal. */
  liveTopo: Ref<MapTopology | null>;
  /** epoch ms — feeds the timeline strip's live countdown. */
  nextRefreshAt: Ref<number | null>;
  stages: ReturnType<typeof useInfra3dPipeline>['stages'];
  stageOrder: ReturnType<typeof useInfra3dPipeline>['stageOrder'];
  pipelineRunning: ReturnType<typeof useInfra3dPipeline>['running'];
  /** FULL run + (re)arm the timer — landing + manual refresh button. */
  refreshNow: () => void;
  /** FULL run once, then arm the auto-refresh timer. Used at mount. */
  start: () => void;
  /** Tear down the refresh timer — call on unmount. */
  stopRefresh: () => void;
}

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

export function useInfra3dLoader(deps: Infra3dLoaderDeps): Infra3dLoader {
  const {
    infraConfig,
    levelsOrdered,
    infraGroups,
    levelForLayer,
    isLayerExcluded,
    menuLayers,
    planeOrder,
    liveTopologyEnabled,
  } = deps;

  const { stages, stageOrder, running: pipelineRunning, run: runPipelineState } = useInfra3dPipeline();

  const liveTopo = shallowRef<MapTopology | null>(null);
  const liveWindow = (): LiveWindow => ({
    startMs: Date.now() - 2 * 3600_000,
    endMs: Date.now(),
    step: 'HOUR',
  });

  // Refresh modes. Landing + manual refresh run the FULL pipeline (templates
  // + layout/clustering resolve here, once). The 60s auto-refresh runs LIGHT
  // — services + topologies + metrics only — reusing templates/layout from
  // the last full run. `knownLayers` is the template set captured at the last
  // full run; a layer that appears only on a light refresh has no template,
  // so its services are hidden until the next full (manual / page) refresh.
  type PipelineMode = 'full' | 'light';
  const pipelineMode = shallowRef<PipelineMode>('full');
  const knownLayers = shallowRef<Set<string> | null>(null);
  // Cross-layer hierarchy cache (LAYER::serviceId → entry | null), persisted
  // across refreshes. The hierarchy stage fetches ONLY services missing from
  // here and reuses the rest, so a steady roster costs zero OAP calls; a
  // `null` records "checked, no peers" so it isn't re-probed.
  const hierarchyCache = new Map<string, MapHierarchyEntry | null>();

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

  // Auto-refresh: re-run the pipeline every REFRESH_MS. A self-rescheduling
  // timeout (not setInterval) so a manual refresh resets the countdown
  // cleanly instead of drifting against a fixed interval. `nextRefreshAt`
  // (epoch ms) feeds the timeline strip's live countdown. Cleared on unmount.
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const nextRefreshAt = shallowRef<number | null>(null);

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

  function start(): void {
    void runFull();
    scheduleRefresh();
  }

  function stopRefresh(): void {
    if (refreshTimer !== null) clearTimeout(refreshTimer);
  }

  return {
    liveTopo,
    nextRefreshAt,
    stages,
    stageOrder,
    pipelineRunning,
    refreshNow,
    start,
    stopRefresh,
  };
}
