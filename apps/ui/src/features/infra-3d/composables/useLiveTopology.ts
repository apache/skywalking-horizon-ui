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
 * Live assembly of the 3D-map topology — the sequential, low-concurrency
 * counterpart to the committed `fallback-topology.json` snapshot.
 *
 * The output is a `MapTopology` byte-compatible with `loadFallbackTopology()`,
 * so `buildSceneGraph` consumes either source unchanged. It is built from OAP
 * one layer at a time: per-layer service rosters (stage `services`), per-layer
 * service maps (stage `topologies`), and the cross-layer Smartscape peers
 * (stage `hierarchy`, `loadLiveHierarchy` — incremental: only newly-appeared
 * services are fetched, the rest reused from the caller's cache). Cross-layer
 * CALL edges, by contrast, fall out of `buildSceneGraph` from cross-layer
 * entries in `topologies[].calls`, so nothing here pre-computes those. Each
 * stage owns its own `StageReporter` — see Infra3DView's live pipeline impls.
 */

import type { LayerDef, ServiceHierarchyResponse } from '@skywalking-horizon-ui/api-client';
import { bff } from '@/api/client';
import type {
  MapHierarchyEntry,
  MapHierarchyPeer,
  MapLayer,
  MapLayerTopology,
  MapServiceRef,
  MapTopology,
  MapTopologyCall,
} from './useMapTopology';
import type { StageReporter, TopologyProbe } from './useInfra3dPipeline';

export interface LiveWindow {
  startMs: number;
  endMs: number;
  step: 'MINUTE' | 'HOUR' | 'DAY';
}

/** A layer ships a service-map iff OAP advertises the `serviceMap` cap —
 *  the same signal that gates the 2D Service Map page and the only layers
 *  `bff.layer.topology` returns edges for. */
export function isTopologyBearing(L: LayerDef): boolean {
  return L.caps.serviceMap === true;
}

/** Active layers with at least one reporting service, tier-ordered (level
 *  asc, then key) to match the snapshot's ordering. `serviceCount` of -1
 *  (OAP unreachable) or 0 is dropped so the scene never gains empty zones. */
export function liveRoster(layers: LayerDef[]): LayerDef[] {
  return layers
    .filter((L) => L.active && L.serviceCount > 0)
    .slice()
    .sort(
      (a, b) =>
        (a.level ?? Number.MAX_SAFE_INTEGER) - (b.level ?? Number.MAX_SAFE_INTEGER) ||
        a.key.localeCompare(b.key),
    );
}

function toMapLayer(L: LayerDef): MapLayer {
  return {
    key: L.key,
    name: L.name,
    level: L.level,
    group: L.group ?? null,
    serviceCount: L.serviceCount,
    color: L.color,
  };
}

/** Layers-only skeleton; `servicesByLayer` / `topologies` / `hierarchy`
 *  fill in as the sequential stages land. */
export function liveSkeleton(roster: LayerDef[]): MapTopology {
  return {
    capturedAt: new Date().toISOString(),
    source: 'live',
    layers: roster.map(toMapLayer),
    servicesByLayer: {},
    hierarchy: [],
    topologies: {},
  };
}

/** Stage `services` — read each layer's roster from OAP one at a time,
 *  reporting per-layer progress. Mutates `topo.servicesByLayer` and returns
 *  the running service total. An unreachable layer contributes nothing
 *  (never a fabricated row) and is logged, not thrown — a single failure
 *  must not abort the pipeline. */
export async function loadLiveServices(
  rep: StageReporter,
  roster: LayerDef[],
  topo: MapTopology,
  hiddenNoTemplate: string[] = [],
): Promise<number> {
  rep.start();
  let total = 0;
  for (let i = 0; i < roster.length; i++) {
    const L = roster[i]!;
    rep.progress(`reading ${L.key} services (${i + 1}/${roster.length})`, {
      kind: 'services',
      servicesTotal: total,
      layersTotal: Object.keys(topo.servicesByLayer).length,
      addedSince: null,
      removedSince: null,
      hiddenNoTemplate,
    });
    try {
      const resp = await bff.layer.services(L.key);
      if (resp.reachable && resp.services.length > 0) {
        const refs: MapServiceRef[] = resp.services.map((s) => ({
          id: s.id,
          name: s.name,
          normal: s.normal ?? true,
        }));
        topo.servicesByLayer[L.key] = refs;
        total += refs.length;
      }
    } catch (err) {
      console.warn(`[infra-3d] live services failed for ${L.key}:`, err);
    }
  }
  const layerCount = Object.keys(topo.servicesByLayer).length;
  const summary =
    hiddenNoTemplate.length > 0
      ? `${total} services / ${layerCount} layers · ${hiddenNoTemplate.length} hidden (no template)`
      : `${total} services / ${layerCount} layers`;
  rep.ok(summary, {
    kind: 'services',
    servicesTotal: total,
    layersTotal: layerCount,
    addedSince: null,
    removedSince: null,
    hiddenNoTemplate,
  });
  return total;
}

/** Stage `topologies` — pull each topology-bearing layer's service map one
 *  at a time. Builds a `MapLayerTopology` (calls + faithful-but-inert nodes)
 *  and a per-layer `TopologyProbe`. Per-layer try/catch so one failure
 *  records a `failed` probe and continues. */
export async function loadLiveTopologies(
  rep: StageReporter,
  topoLayers: LayerDef[],
  topo: MapTopology,
  window: LiveWindow,
): Promise<TopologyProbe[]> {
  rep.start();
  const probes: TopologyProbe[] = [];
  for (let i = 0; i < topoLayers.length; i++) {
    const L = topoLayers[i]!;
    rep.progress(`fetching ${L.key} topology (${i + 1}/${topoLayers.length})`, {
      kind: 'topologies',
      probes,
    });
    const t0 = performance.now();
    try {
      const resp = await bff.layer.topology(L.key, undefined, 1, window);
      const map: MapLayerTopology = {
        nodes: resp.nodes.map((n) => ({ id: n.id, name: n.name, layer: L.key })),
        calls: resp.calls.map<MapTopologyCall>((c) => ({
          source: c.source,
          target: c.target,
          detectPoints: c.detectPoints,
        })),
      };
      topo.topologies[L.key] = map;
      probes.push({
        layerKey: L.key,
        status: resp.reachable ? (map.calls.length > 0 ? 'ok' : 'empty') : 'failed',
        ms: Math.round(performance.now() - t0),
        nodeCount: map.nodes.length,
        edgeCount: map.calls.length,
        error: resp.reachable ? undefined : resp.error,
      });
    } catch (err) {
      probes.push({
        layerKey: L.key,
        status: 'failed',
        ms: Math.round(performance.now() - t0),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const okCount = probes.filter((p) => p.status === 'ok').length;
  const failed = probes.filter((p) => p.status === 'failed').length;
  const detail = { kind: 'topologies' as const, probes };
  if (failed > 0) rep.warn(`${okCount} maps with edges · ${failed} failed`, detail);
  else rep.ok(`${okCount} maps with edges`, detail);
  return probes;
}

/** Cache key — `LAYER::serviceId`, the unique identity of a service projection. */
function hierKey(layer: string, id: string): string {
  return `${layer.toUpperCase()}::${id}`;
}

/** Flatten OAP's per-layer hierarchy response into the snapshot's
 *  `MapHierarchyEntry` shape: drop the focused service's own layer + the
 *  `self` peer, keep the cross-layer twins. Returns null when the service
 *  has no cross-layer projection (so the cache records "checked, none"). */
function toHierarchyEntry(
  layer: string,
  ref: MapServiceRef,
  resp: ServiceHierarchyResponse,
): MapHierarchyEntry | null {
  if (!resp.reachable || resp.relations <= 0) return null;
  const peers: MapHierarchyPeer[] = resp.peers
    .filter((g) => g.layer.toUpperCase() !== layer.toUpperCase())
    .map((g) => ({
      layer: g.layer,
      services: g.services
        .filter((s) => s.role !== 'self')
        .map((s) => ({ id: s.id, name: s.name, normal: s.normal, role: s.role })),
    }))
    .filter((g) => g.services.length > 0);
  if (peers.length === 0) return null;
  return {
    fromLayer: layer,
    fromService: { id: ref.id, name: ref.name, normal: ref.normal },
    peers,
  };
}

/** Stage `hierarchy` — assemble the cross-layer Smartscape peers.
 *
 *  INCREMENTAL: `getServiceHierarchy` is one call per service, so only
 *  services NOT already in `cache` are fetched; existing entries are reused
 *  and entries for services that vanished are dropped. `cache` is owned by
 *  the caller and persists across refreshes, so an unchanged roster costs
 *  ZERO OAP calls — the "reuse the initialization data, only fetch new
 *  services" contract. The scene reveals these tubes only for the selected
 *  cube, so the caller must populate `topo.hierarchy` (done here) BEFORE
 *  publishing `liveTopo` / building the scene graph. */
export async function loadLiveHierarchy(
  rep: StageReporter,
  topo: MapTopology,
  cache: Map<string, MapHierarchyEntry | null>,
): Promise<void> {
  rep.start();
  const current: Array<{ layer: string; ref: MapServiceRef }> = [];
  for (const [layer, refs] of Object.entries(topo.servicesByLayer)) {
    for (const ref of refs) current.push({ layer, ref });
  }
  const present = new Set(current.map((c) => hierKey(c.layer, c.ref.id)));
  for (const k of [...cache.keys()]) {
    if (present.has(k)) continue;
    cache.delete(k);
  }

  const fresh = current.filter((c) => !cache.has(hierKey(c.layer, c.ref.id)));
  const reused = current.length - fresh.length;
  const CONC = 6;
  for (let i = 0; i < fresh.length; i += CONC) {
    const batch = fresh.slice(i, i + CONC);
    rep.progress(`reading hierarchy (${Math.min(i + CONC, fresh.length)}/${fresh.length} new · ${reused} reused)`, {
      kind: 'hierarchy',
      servicesTotal: current.length,
      fetched: i,
      reused,
      links: 0,
    });
    await Promise.all(
      batch.map(async (c) => {
        const k = hierKey(c.layer, c.ref.id);
        try {
          const resp = await bff.layer.serviceHierarchy(c.layer, c.ref.id);
          // Success caches the result (an entry, or null for "checked, no
          // peers") so it isn't re-probed. A FAILURE is NOT cached — leaving
          // the key absent re-fetches it next refresh rather than freezing a
          // transient error into a permanent "no hierarchy" for the page.
          cache.set(k, toHierarchyEntry(c.layer, c.ref, resp));
        } catch (err) {
          console.warn(`[infra-3d] live hierarchy failed for ${k}:`, err);
        }
      }),
    );
  }

  const entries = [...cache.values()].filter((e): e is MapHierarchyEntry => e !== null);
  topo.hierarchy = entries;
  rep.ok(`${entries.length} cross-layer links · ${fresh.length} fetched / ${reused} reused`, {
    kind: 'hierarchy',
    servicesTotal: current.length,
    fetched: fresh.length,
    reused,
    links: entries.length,
  });
}
