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

import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import type {
  AggregationKind,
  LandingConfig,
  LayerCaps,
  LayerConfig,
  LayerSlots,
} from '@skywalking-horizon-ui/api-client';
import { bffClient } from '@/api/client';
import {
  defaultColumnsForLayer,
  defaultOrderByForLayer,
  defaultSparkForLayer,
} from '@/composables/metricCatalog';

export type { LayerConfig, LandingConfig };

/** Default-priority table per the design (General → Virtual* → Mesh → K8s). */
function defaultPriority(layerKey: string): number {
  const k = layerKey.toLowerCase();
  if (k === 'general') return 10;
  if (k.startsWith('virtual_')) return 20;
  if (k === 'mesh' || k === 'mesh_cp' || k === 'mesh_dp') return 30;
  if (k === 'k8s' || k === 'k8s_service') return 40;
  return 99;
}

/**
 * Sensible default aggregation per metric. Throughput-shaped keys (cpm,
 * msg-rate, qps, pv, invocations, tokens, page views, requests) default
 * to `sum` so the layer-wide KPI tile reflects whole-layer traffic.
 * Latency / SLA / percentile / error / apdex default to `avg`.
 */
function defaultAggregationFor(metricKey: string): AggregationKind {
  const k = metricKey.toLowerCase();
  if (
    k === 'cpm' ||
    k.endsWith('.msg-rate') ||
    k.endsWith('.qps') ||
    k.endsWith('.pv') ||
    k.endsWith('.invocations') ||
    k.endsWith('.tokens') ||
    k.endsWith('.req') ||
    k.endsWith('.slow-queries') ||
    k.endsWith('.js-err') ||
    k.endsWith('.cold-start') ||
    k.endsWith('.restart')
  ) {
    return 'sum';
  }
  return 'avg';
}

export function defaultLandingFor(layerKey: string): LandingConfig {
  const cols = defaultColumnsForLayer(layerKey).map((c) => ({
    ...c,
    aggregation: defaultAggregationFor(c.metric),
  }));
  const sparkMetric = defaultSparkForLayer(layerKey);
  return {
    priority: defaultPriority(layerKey),
    topN: 5,
    orderBy: defaultOrderByForLayer(layerKey),
    columns: cols,
    spark: { metric: sparkMetric, height: 28 },
    // Throughput tile defaults to the orderBy metric — operator can
    // override or remove via Setup. `sum` matches whole-layer traffic.
    throughput: {
      metric: defaultOrderByForLayer(layerKey),
      aggregation: defaultAggregationFor(defaultOrderByForLayer(layerKey)),
    },
    style: 'table',
  };
}

export function defaultLayerConfig(
  layerKey: string,
  defaults: { slots: LayerSlots; caps: LayerCaps },
): LayerConfig {
  return {
    slots: { ...defaults.slots },
    caps: { ...defaults.caps },
    landing: defaultLandingFor(layerKey),
  };
}

/**
 * Layer customization store.
 *
 * Lifecycle:
 *   1. `bootstrap()` hydrates the persisted overrides from `GET /api/setup`.
 *   2. `ensure(key, defaults)` returns the editable config — creating one
 *      from `defaults` on first touch.
 *   3. UI mutations mark `dirty` true.
 *   4. `save()` POSTs `/api/setup` and clears `dirty`.
 *   5. `reset(key, defaults)` rebuilds a single layer from defaults.
 *   6. `discard()` re-hydrates from server, dropping local changes.
 *
 * The BFF JSON store is the source of truth until OAP-side template
 * management lands. See packages/api-client/src/setup.ts for the wire
 * shape.
 */
export const useSetupStore = defineStore('setup', () => {
  const configs = reactive<Record<string, LayerConfig>>({});
  const dirty = ref(false);
  const loading = ref(false);
  const saving = ref(false);
  const lastError = ref<string | null>(null);
  const bootstrapped = ref(false);
  /** Last server-known shape; used by `discard()` to revert. */
  let serverSnapshot: Record<string, LayerConfig> = {};

  function applyServerSnapshot(layers: Record<string, LayerConfig>): void {
    serverSnapshot = JSON.parse(JSON.stringify(layers));
    for (const k of Object.keys(configs)) delete configs[k];
    for (const [k, v] of Object.entries(layers)) configs[k] = JSON.parse(JSON.stringify(v));
    dirty.value = false;
  }

  async function bootstrap(): Promise<void> {
    if (bootstrapped.value || loading.value) return;
    loading.value = true;
    lastError.value = null;
    try {
      const res = await bffClient.loadSetup();
      applyServerSnapshot(res.layers);
      bootstrapped.value = true;
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : 'failed to load setup';
    } finally {
      loading.value = false;
    }
  }

  function markDirty(): void {
    if (!dirty.value) dirty.value = true;
  }

  /**
   * Return the operator's config for a layer, creating one from defaults
   * on first touch. Calls into this from a `computed()` MUTATE the store —
   * intentional: the Pinia reactive proxy then makes every form-field
   * binding write-through.
   */
  function ensure(
    layerKey: string,
    defaults: { slots: LayerSlots; caps: LayerCaps },
  ): LayerConfig {
    let cfg = configs[layerKey];
    if (!cfg) {
      cfg = defaultLayerConfig(layerKey, defaults);
      configs[layerKey] = cfg;
      // Newly-created defaults aren't "dirty" — only explicit edits should
      // turn the Save button on. We track that by leaving `dirty` alone
      // here and relying on form-field bindings to flip it via deep proxy
      // watchers below.
    }
    return cfg;
  }

  function reset(
    layerKey: string,
    defaults: { slots: LayerSlots; caps: LayerCaps },
  ): void {
    configs[layerKey] = defaultLayerConfig(layerKey, defaults);
    markDirty();
  }

  async function save(): Promise<void> {
    if (saving.value) return;
    saving.value = true;
    lastError.value = null;
    try {
      // Strip layers that match defaults exactly? Keep all touched layers
      // for now — server stores them sparse but client sends the full set.
      const payload = JSON.parse(JSON.stringify(configs)) as Record<string, LayerConfig>;
      const res = await bffClient.saveSetup({ layers: payload });
      applyServerSnapshot(res.layers);
    } catch (err) {
      lastError.value = err instanceof Error ? err.message : 'save failed';
      throw err;
    } finally {
      saving.value = false;
    }
  }

  async function discard(): Promise<void> {
    applyServerSnapshot(serverSnapshot);
  }

  // Per-template Vue proxy mutation tracking — every form binding
  // mutates `configs[layer].…`. We hook the proxy via a Pinia subscribe.
  // Simpler: just call `markDirty` from the form handler. Form bindings
  // (`v-model="cfg.slots.services"`) go through Pinia, but we can't tell
  // a programmatic write from a user edit without an explicit signal.
  // → expose `markDirty` and call it from LayerSetupCard on input.

  return {
    // state
    configs,
    dirty,
    loading,
    saving,
    bootstrapped,
    lastError,
    // computed
    layerCount: computed(() => Object.keys(configs).length),
    // actions
    bootstrap,
    ensure,
    reset,
    markDirty,
    save,
    discard,
  };
});
