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
 * Singleton-per-app composable that fetches the 3D Infrastructure Map
 * admin config from the BFF and surfaces ergonomic lookups
 * (`levelForLayer`, `colorForLayer`, `mqeForLayer`, …).
 *
 * The config is small (< 10 KB) and rarely changes, so a single in-memory
 * snapshot is enough — there is no refresh ticker. Callers that want a
 * post-save refresh can call `refresh()` directly.
 *
 * Why pre-compute lookup maps: the scene iterates over hundreds of nodes
 * per frame for tooltip / hover hit-detection; doing an O(levels × layers)
 * scan inside `planeForLayer` was the simplest correct version, but the
 * config-driven path expands that to an O(L) regex test per layer per
 * frame. Pre-computing `layerToLevelId` once per config snapshot brings
 * the per-frame cost back to O(1).
 */

import { computed, readonly, ref, shallowRef } from 'vue';
import { bff } from '../../../api/client';
import type {
  Infra3dConfig,
  InfraLayerSpec,
  InfraGroupSpec,
  InfraLevelSpec,
  InfraMqe,
} from '../../../api/client';

/** Module-level snapshot — the 3D view, the admin editor, and any
 *  other surface that consumes the config all share one fetch. */
const cfg = shallowRef<Infra3dConfig | null>(null);
const error = ref<string | null>(null);
const loading = ref(false);
let inFlight: Promise<Infra3dConfig> | null = null;

/** Resolved derived maps recomputed when `cfg` changes. */
const layerToLevelId = computed<Record<string, string>>(() => {
  const c = cfg.value;
  if (!c) return {};
  const filter = safeRegex(c.filter.layer);
  const out: Record<string, string> = {};

  // Logic-group membership wins outright: a grouped layer is placed on
  // the group's level, overriding the layer's own level resolution. A
  // layer belongs to one group (validated), but resolve first-match to
  // agree with placement (useScenePlacement) should that ever be violated.
  for (const g of c.groups ?? []) {
    for (const k of g.layers) {
      const u = k.toUpperCase();
      if (filter && !filter.test(u)) continue;
      if (!out[u]) out[u] = g.level;
    }
  }

  // Explicit `layers` lists are the only per-level placement mechanism —
  // a layer pinned to a level lands there. Anything no group or explicit
  // list claims falls to `unknownLayer.level` (the single failover tier)
  // via `levelForLayer` below.
  for (const lvl of c.levels) {
    for (const k of lvl.layers) {
      const u = k.toUpperCase();
      if (filter && !filter.test(u)) continue;
      if (!out[u]) out[u] = lvl.id;
    }
  }
  return out;
});

const levelsOrdered = computed<InfraLevelSpec[]>(() => {
  if (!cfg.value) return [];
  return [...cfg.value.levels].sort((a, b) => a.order - b.order);
});

const groups = computed<InfraGroupSpec[]>(() => cfg.value?.groups ?? []);

/** layer key (upper) → group id, for the layers that belong to a group. */
const layerToGroupId = computed<Record<string, string>>(() => {
  const c = cfg.value;
  if (!c) return {};
  const out: Record<string, string> = {};
  // First-match wins, matching placement (a layer is in one group anyway).
  for (const g of c.groups ?? []) {
    for (const k of g.layers) {
      const u = k.toUpperCase();
      if (!out[u]) out[u] = g.id;
    }
  }
  return out;
});

/** Public reader hook. Multiple callers share the same fetch + snapshot. */
export function useInfra3dConfig() {
  return {
    config: readonly(cfg),
    levelsOrdered: readonly(levelsOrdered),
    /** Logic groups from the config (e.g. Self-Observability). A computed,
     *  so already read-only; not wrapped in readonly() so it stays
     *  structurally assignable to the Scene's groups prop. */
    groups,
    loading: readonly(loading),
    error: readonly(error),
    /** Trigger a fetch if not already loaded. Resolves with the live
     *  snapshot. Concurrent callers share one in-flight request. */
    ensureLoaded,
    /** Force a re-fetch (after admin save). */
    refresh,
    /** Resolve a layer to its level id; falls back to the configured
     *  `unknownLayer.level` (default `middleware`) if the layer is not
     *  recognized or is filtered out by the global regex. */
    levelForLayer,
    /** Render color for a layer. Falls back to the configured unknown
     *  badge color if the layer is missing from the config. */
    colorForLayer,
    /** The logic group a layer belongs to, or null if ungrouped. */
    groupForLayer,
    /** Resolved single traffic MQE for a layer — `metric` (canonical),
     *  falling back to the deprecated `topology` / `load` shapes for
     *  older saved rows. Returns null when no MQE is configured. */
    trafficMqeForLayer,
    /** Raw per-layer spec (color + metric). */
    layerSpec,
    /** True when the global filter excludes a layer from the map. */
    isLayerExcluded,
  };
}

export async function ensureLoaded(): Promise<Infra3dConfig> {
  if (cfg.value) return cfg.value;
  if (inFlight) return inFlight;
  loading.value = true;
  inFlight = (async () => {
    try {
      const r = await bff.infra3d.config();
      cfg.value = r;
      error.value = null;
      return r;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      loading.value = false;
      inFlight = null;
    }
  })();
  return inFlight;
}

export async function refresh(): Promise<Infra3dConfig> {
  cfg.value = null;
  return ensureLoaded();
}

export function levelForLayer(layerKey: string): string {
  const u = layerKey.toUpperCase();
  const m = layerToLevelId.value[u];
  if (m) return m;
  return cfg.value?.unknownLayer.level ?? 'middleware';
}

/** True when the global `filter.layer` regex excludes this layer — it is
 *  OFF the 3D map entirely (not rendered on any tier), matching the admin
 *  editor's treatment. Default `.*` excludes nothing. */
export function isLayerExcluded(layerKey: string): boolean {
  const f = cfg.value?.filter.layer;
  if (!f) return false;
  const r = safeRegex(f);
  return r ? !r.test(layerKey.toUpperCase()) : false;
}

export function colorForLayer(layerKey: string): string {
  const u = layerKey.toUpperCase();
  const spec = cfg.value?.layers[u];
  return spec?.color ?? '#8a8a8a';
}

/** The logic group a layer belongs to, or null if ungrouped. */
export function groupForLayer(layerKey: string): InfraGroupSpec | null {
  const id = layerToGroupId.value[layerKey.toUpperCase()];
  if (!id) return null;
  return cfg.value?.groups?.find((g) => g.id === id) ?? null;
}

export function layerSpec(layerKey: string): InfraLayerSpec | null {
  const u = layerKey.toUpperCase();
  return cfg.value?.layers[u] ?? null;
}

/** Resolved single MQE used for the cube's traffic ring. Apply
 *  server-preferred / client-fallback for topology layers; fall through
 *  to `load` for non-topology layers. */
export function trafficMqeForLayer(layerKey: string): InfraMqe | null {
  const spec = layerSpec(layerKey);
  if (!spec) return null;
  // `metric` is canonical; topology/load are accepted for back-compat
  // (older saved rows) and collapse to the same single value.
  if (spec.metric) return spec.metric;
  if (spec.topology?.server) return spec.topology.server;
  if (spec.topology?.client) return spec.topology.client;
  return spec.load ?? null;
}

function safeRegex(src: string): RegExp | null {
  try {
    return new RegExp(src);
  } catch {
    return null;
  }
}
