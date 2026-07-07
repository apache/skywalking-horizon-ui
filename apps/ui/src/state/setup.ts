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
import { reactive } from 'vue';
import type {
  AggregationKind,
  LandingConfig,
  LayerCaps,
  LayerConfig,
  LayerMetricsConfig,
  LayerSlots,
} from '@skywalking-horizon-ui/api-client';
import {
  defaultColumnsForLayer,
  defaultOrderByForLayer,
} from '@/utils/metricCatalog';

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

/**
 * Build the initial LandingConfig for a layer. When the BFF
 * surfaces a `metrics` block from the JSON template, prefer it as the
 * source of truth — that's what the operator edits in
 * `apps/bff/src/bundled_templates/layers/<layer>.json` / via the admin page.
 * Falls back to the static metric-catalog defaults when no template
 * metrics arrived (e.g. layers without a JSON config file).
 */
export function defaultLandingFor(
  layerKey: string,
  fromHeader?: LayerMetricsConfig,
): LandingConfig {
  // ---- Per-layer page header (service-list columns + default sort).
  //      Drives the per-layer Service page's picker table. Overview is
  //      now self-contained and does NOT cross-reference these. ----
  // A template that ships `columns: []` is the operator's explicit
  // way of saying "no service-level header KPIs for this layer" — most
  // commonly because the layer's underlying meters are
  // SERVICE_INSTANCE-only (so11y_java_agent, so11y_oap, etc., where a
  // service-scope query would just return `null`). Honor that as-is.
  // Only when the template provides NO `columns` array at all (legacy
  // / un-templated layers) do we synthesize the static
  // RPC-cpm/resp/sla defaults.
  const headerCols = fromHeader?.columns !== undefined
    ? fromHeader.columns.map((c) => ({
        metric: c.metric,
        label: c.label,
        ...(c.unit ? { unit: c.unit } : {}),
        ...(c.mqe ? { mqe: c.mqe } : {}),
        aggregation: c.aggregation ?? defaultAggregationFor(c.metric),
        ...(c.scale !== undefined ? { scale: c.scale } : {}),
        ...(c.precision !== undefined ? { precision: c.precision } : {}),
      }))
    : defaultColumnsForLayer(layerKey).map((c) => ({
        ...c,
        aggregation: defaultAggregationFor(c.metric),
      }));
  // Use `||` not `??` so an empty string (template with no header
  // columns intentionally omits the orderBy) falls through to the
  // first synthesized column / static default. The BFF schema
  // rejects `orderBy: ""` (z.string().min(1)) so this must never
  // ship empty.
  const orderBy =
    (fromHeader?.orderBy && fromHeader.orderBy.length > 0 ? fromHeader.orderBy : null) ??
    headerCols[0]?.metric ??
    defaultOrderByForLayer(layerKey);

  return {
    priority: defaultPriority(layerKey),
    topN: 5,
    orderBy,
    columns: headerCols,
  };
}

export function defaultLayerConfig(
  layerKey: string,
  defaults: {
    slots: LayerSlots;
    caps: LayerCaps;
    metrics?: LayerMetricsConfig;
  },
): LayerConfig {
  return {
    slots: { ...defaults.slots },
    caps: { ...defaults.caps },
    landing: defaultLandingFor(layerKey, defaults.metrics),
  };
}

/**
 * Layer config resolver.
 *
 * Derives each layer's rendered `LayerConfig` (slots / caps / landing) from that
 * layer's template defaults and caches it per layer so many components can read a
 * stable object. The layer template is the source of truth — authored in the
 * Layer dashboards admin and OAP-synced; this store holds NO server state and
 * persists nothing (there is no separate per-layer override store).
 */
export const useSetupStore = defineStore('setup', () => {
  const configs = reactive<Record<string, LayerConfig>>({});

  /**
   * Return the resolved config for a layer, deriving it from `defaults` on first
   * touch and caching it. Called from `computed()` deliberately: the cache write
   * happens once per layer, and every subsequent read returns the cached object
   * WITHOUT mutating — so a computed reading `ensure(...).landing` never triggers
   * a reactive cascade (an earlier per-read reconciliation pass did, which froze
   * AppSidebar / LayerShell with "Maximum recursive updates exceeded").
   */
  function ensure(
    layerKey: string,
    defaults: {
      slots: LayerSlots;
      caps: LayerCaps;
      metrics?: LayerMetricsConfig;
    },
  ): LayerConfig {
    let cfg = configs[layerKey];
    if (!cfg) {
      cfg = defaultLayerConfig(layerKey, defaults);
      configs[layerKey] = cfg;
    }
    return cfg;
  }

  /** Side-effect-free priority read — used from `useLandingOrder` inside a
   *  computed, so it MUST NOT call `ensure()` or otherwise mutate the store. */
  function priorityFor(layerKey: string): number {
    return configs[layerKey]?.landing.priority ?? defaultPriority(layerKey);
  }

  return { configs, ensure, priorityFor };
});
