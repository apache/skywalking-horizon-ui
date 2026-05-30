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
 * counterpart to the committed `demo-topology.json` snapshot.
 *
 * The output is a `DemoTopology` byte-compatible with `loadDemoTopology()`,
 * so `buildSceneGraph` consumes either source unchanged. It is built one
 * layer at a time (concurrency 1) from OAP: per-layer service rosters
 * (stage `services`) and per-layer service maps (stage `topologies`).
 *
 * Phase-1 scope: cross-layer call edges fall out of `buildSceneGraph`
 * itself (it derives them from cross-layer entries in `topologies[].calls`),
 * so nothing here pre-computes them; `hierarchy` stays `[]` (the Smartscape
 * peers are a later phase, fetched per-service). The reporter wiring is
 * split across the two stages by the caller so each owns its own
 * `StageReporter` — see Infra3DView's live pipeline impls.
 */

import type { LayerDef } from '@skywalking-horizon-ui/api-client';
import { bff } from '@/api/client';
import type {
  DemoLayer,
  DemoLayerTopology,
  DemoServiceRef,
  DemoTopology,
  DemoTopologyCall,
} from './useDemoTopology';
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

function toDemoLayer(L: LayerDef): DemoLayer {
  return {
    key: L.key,
    name: L.name,
    level: L.level,
    group: L.group ?? null,
    serviceCount: L.serviceCount,
    color: L.color,
  };
}

/** Layers-only skeleton; `servicesByLayer` / `topologies` fill in as the
 *  sequential stages land. `hierarchy` stays `[]` in Phase 1. */
export function liveSkeleton(roster: LayerDef[]): DemoTopology {
  return {
    capturedAt: new Date().toISOString(),
    oapDemo: 'live',
    layers: roster.map(toDemoLayer),
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
  topo: DemoTopology,
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
        const refs: DemoServiceRef[] = resp.services.map((s) => ({
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
 *  at a time. Builds a `DemoLayerTopology` (calls + faithful-but-inert nodes)
 *  and a per-layer `TopologyProbe`. Per-layer try/catch so one failure
 *  records a `failed` probe and continues. */
export async function loadLiveTopologies(
  rep: StageReporter,
  topoLayers: LayerDef[],
  topo: DemoTopology,
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
      const map: DemoLayerTopology = {
        nodes: resp.nodes.map((n) => ({ id: n.id, name: n.name, layer: L.key })),
        calls: resp.calls.map<DemoTopologyCall>((c) => ({
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
