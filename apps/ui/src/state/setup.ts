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
  LayerMetricsConfig,
  LayerOverviewConfig,
  LayerSlots,
} from '@skywalking-horizon-ui/api-client';
import { bffClient } from '@/api/client';
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
  fromOverview?: LayerOverviewConfig,
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

  // ---- Overview tile groups. Each group becomes one tile on the
  //      Overview strip with its own title + size. Metrics inside a
  //      group are still self-contained (mqe / label / aggregation),
  //      promoted into synthetic landing columns so the BFF batches
  //      every Overview MQE in the same query. ----
  let counter = 0;
  const ovCols: LandingConfig['columns'] = [];
  const overviewGroups: NonNullable<LandingConfig['overviewGroups']> = [];
  const sourceGroups = fromOverview?.groups ??
    (fromOverview?.metrics && fromOverview.metrics.length > 0
      ? [{ title: '', size: 'auto' as const, metrics: fromOverview.metrics }]
      : []);
  for (const g of sourceGroups) {
    const ids: string[] = [];
    for (const m of g.metrics) {
      const id = m.id ?? `ov_${counter++}`;
      // Dedupe across groups: if two groups reference the same id, the
      // column lands once and both groups share the result.
      if (!ovCols.some((c) => c.metric === id)) {
        ovCols.push({
          metric: id,
          label: m.label,
          ...(m.tip ? { tip: m.tip } : {}),
          ...(m.unit ? { unit: m.unit } : {}),
          mqe: m.mqe,
          aggregation: m.aggregation ?? defaultAggregationFor(id),
          ...(m.scale !== undefined ? { scale: m.scale } : {}),
          ...(m.precision !== undefined ? { precision: m.precision } : {}),
        });
      }
      ids.push(id);
    }
    overviewGroups.push({
      title: g.title ?? '',
      size: g.size === 'square' ? 'square' : 'auto',
      metricIds: ids,
    });
  }
  const ovIds = ovCols.map((c) => c.metric);

  // Combine: header columns first (so order-by lookups stay stable),
  // then Overview metrics. Duplicates collapse — Overview wins because
  // it carries the operator's intent for the tile.
  const combined: LandingConfig['columns'] = [];
  for (const c of headerCols) {
    if (!ovIds.includes(c.metric)) combined.push(c);
  }
  for (const c of ovCols) combined.push(c);

  return {
    priority: defaultPriority(layerKey),
    topN: 5,
    orderBy,
    columns: combined,
    // The original header-column set, preserved here so the LayerShell
    // KPI strip can render ONLY these (the combined `columns` above
    // also carries overview-promoted entries which would otherwise
    // bleed into the header — wrong for so11y_* layers whose overview
    // metrics are SERVICE_INSTANCE-only and show as `—` on the
    // Service page header).
    headerColumns: headerCols,
    // Flat list of overview metric ids (legacy back-compat for any
    // code path still reading it). Same set, flattened from groups.
    overviewMetrics: ovIds.length > 0 ? ovIds : [orderBy],
    overviewGroups: overviewGroups.length > 0
      ? overviewGroups
      : [{ title: '', size: 'auto', metricIds: [orderBy] }],
    style: 'table',
  };
}

export function defaultLayerConfig(
  layerKey: string,
  defaults: {
    slots: LayerSlots;
    caps: LayerCaps;
    metrics?: LayerMetricsConfig;
    overview?: LayerOverviewConfig;
  },
): LayerConfig {
  return {
    slots: { ...defaults.slots },
    caps: { ...defaults.caps },
    landing: defaultLandingFor(layerKey, defaults.metrics, defaults.overview),
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
  /** Set of layers whose persisted config has been reconciled against the
   *  current bundle defaults. Each layer is reconciled exactly ONCE per
   *  server snapshot — re-running the patches on every `ensure()` call
   *  was unconditionally re-assigning `landing.headerColumns` (and
   *  similar) and triggering a reactive cascade. With many components
   *  reading `ensure(...).landing` from inside a `computed`, the cascade
   *  hit Vue's recursive-update cap and froze the page. The bootstrap +
   *  discard paths reset this set so the next reconciliation pass runs
   *  against the freshly-loaded server data. */
  const reconciledLayers = new Set<string>();

  function applyServerSnapshot(layers: Record<string, LayerConfig>): void {
    serverSnapshot = JSON.parse(JSON.stringify(layers));
    for (const k of Object.keys(configs)) delete configs[k];
    for (const [k, v] of Object.entries(layers)) configs[k] = JSON.parse(JSON.stringify(v));
    reconciledLayers.clear();
    dirty.value = false;
  }

  async function bootstrap(): Promise<void> {
    if (bootstrapped.value || loading.value) return;
    loading.value = true;
    lastError.value = null;
    try {
      const res = await bffClient.setup.load();
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
    defaults: {
      slots: LayerSlots;
      caps: LayerCaps;
      metrics?: LayerMetricsConfig;
      overview?: LayerOverviewConfig;
    },
  ): LayerConfig {
    let cfg = configs[layerKey];
    if (!cfg) {
      cfg = defaultLayerConfig(layerKey, defaults);
      configs[layerKey] = cfg;
      // Freshly built from defaults — already in canonical shape.
      reconciledLayers.add(layerKey);
      return cfg;
    }
    // Reconciliation is a one-time bootstrap step per server snapshot,
    // not a per-read action. The earlier code re-ran the reconciliation
    // on every `ensure()` call, and several of those writes were
    // unconditional (e.g. `cfg.landing.headerColumns = fresh...`). Since
    // many computeds call `ensure()`, that turned every read into a
    // reactive mutation and produced "Maximum recursive updates exceeded"
    // in AppSidebar / LayerShell. Now we early-return for already-
    // reconciled layers — the reactive read stays pure.
    if (reconciledLayers.has(layerKey)) return cfg;
    reconciledLayers.add(layerKey);
    {
      // Reconcile stale persisted state — three issues to patch:
      //   1. caps fields added after the persisted snapshot. We fill
      //      undefined caps from the template defaults so checkbox
      //      toggles read the right state (undefined → defaults).
      //   2. overview groups / metric ids that don't resolve to any
      //      column → seed the fresh group set.
      //   3. columns that DO resolve but carry stale data (empty mqe
      //      from an old schema) → patch the missing fields from the
      //      fresh template. Operator-edited fields stay untouched
      //      (we never overwrite a non-empty persisted value).
      for (const [k, v] of Object.entries(defaults.caps)) {
        const key = k as keyof typeof cfg.caps;
        if (cfg.caps[key] === undefined) cfg.caps[key] = v;
      }
      const fresh = defaultLandingFor(layerKey, defaults.metrics, defaults.overview);
      // When the bundled template now ships `columns: []` (e.g.
      // so11y_* layers whose meters are SERVICE_INSTANCE-only and have
      // no service-level KPIs), clear any leftover persisted columns —
      // they're stale baggage from a prior bundle version and would
      // resurrect a row of `—` cells. Operators that explicitly want
      // custom columns can re-add them via the setup admin.
      if (fresh.columns.length === 0 && cfg.landing.columns.length > 0) {
        cfg.landing.columns = [];
        cfg.landing.orderBy = fresh.orderBy;
      }
      // Always re-derive `headerColumns` from the fresh template — it's
      // the operator-defined header set (excludes overview-promoted
      // synthetic cols). New field; legacy persisted configs won't
      // have it. We trust the template here rather than preserving
      // stale persisted state because the field is a pure derivation,
      // not operator-editable.
      cfg.landing.headerColumns = fresh.headerColumns;
      // Patch / add columns from the fresh template — only fields
      // that are missing on the persisted column get filled. mqe is
      // the common stale field; this is also where label fixes from
      // a renamed catalog land for un-customized columns.
      for (const fc of fresh.columns) {
        const existing = cfg.landing.columns.find((c) => c.metric === fc.metric);
        if (!existing) {
          cfg.landing.columns.push(fc);
          continue;
        }
        if (!existing.mqe && fc.mqe) existing.mqe = fc.mqe;
        if (existing.label === existing.metric && fc.label) existing.label = fc.label;
        if (!existing.unit && fc.unit) existing.unit = fc.unit;
        if (!existing.aggregation && fc.aggregation) existing.aggregation = fc.aggregation;
        if (!existing.tip && fc.tip) existing.tip = fc.tip;
      }
      // Refresh overviewMetrics / overviewGroups when persisted state
      // is stale (missing groups, or ids that don't resolve).
      const ids = cfg.landing.overviewMetrics ?? [];
      const allResolve = ids.length > 0 && ids.every(
        (id) => cfg.landing.columns.some((c) => c.metric === id),
      );
      const hasGroups = (cfg.landing.overviewGroups?.length ?? 0) > 0;
      if (!allResolve || !hasGroups) {
        cfg.landing.overviewMetrics = fresh.overviewMetrics;
        cfg.landing.overviewGroups = fresh.overviewGroups;
      }
    }
    return cfg;
  }

  function reset(
    layerKey: string,
    defaults: {
      slots: LayerSlots;
      caps: LayerCaps;
      metrics?: LayerMetricsConfig;
      overview?: LayerOverviewConfig;
    },
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
      const res = await bffClient.setup.save({ layers: payload });
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

  /** Side-effect-free priority read. Returns the persisted priority
   *  for a layer when one exists, or the static default otherwise.
   *
   *  Critically, this MUST NOT call `ensure()` or otherwise mutate the
   *  store. `useLandingOrder` reads priority from inside a computed —
   *  using `ensure()` there triggered a recursive-update loop
   *  ("Maximum recursive updates exceeded in component <AppSidebar>")
   *  because `ensure` writes to `configs.<layer>.landing.headerColumns`
   *  on every call, and that's a dependency of the same computed. */
  function priorityFor(layerKey: string): number {
    return configs[layerKey]?.landing.priority ?? defaultPriority(layerKey);
  }

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
    priorityFor,
    reset,
    markDirty,
    save,
    discard,
  };
});
