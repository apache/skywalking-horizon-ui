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

import { computed, type Ref } from 'vue';
import { useQueries, useQuery } from '@tanstack/vue-query';
import type { LandingConfig, OverviewDashboard, OverviewWidget } from '@skywalking-horizon-ui/api-client';
import { bffClient } from '@/api/client';
import { useTimeRangeStore } from '@/controls/timeRange';
import { getPreviewContentFor } from '@/controls/configBundle';
import { overviewEditName } from '@/controls/localTemplateEdits';

/**
 * Resolved value for one overview widget. The renderer reads
 * `values[widget.id]` (or for `kpi-tile`, `kpiValues[widget.id][label]`).
 *
 * Values come from the existing per-layer `landing` route, which already
 * computes layer-wide sum/avg aggregates. We batch one landing call per
 * referenced layer with all that layer's widget MQEs folded into a
 * single `columns` request — N layers => N round-trips, not N*M.
 */
export interface OverviewWidgetValues {
  /** Aggregate value for `metric` / `service-count` widgets. */
  values: Record<string, number | null>;
  /** Per-KPI values for `kpi-tile` widgets, keyed by widget id then label. */
  kpiValues: Record<string, Record<string, number | null>>;
}

interface MqeRequest {
  widgetId: string;
  kpiLabel?: string;
  mqe: string;
  aggregation: 'sum' | 'avg';
  unit?: string;
  /** When true, the `mqe` self-aggregates the layer server-side and the
   *  BFF fires it once (no per-service fan-out). Derived from the widget's
   *  `aggregateOnPage`: self-aggregating unless the widget opts into
   *  page-side aggregation. */
  selfAggregate: boolean;
  /** When set, the widget+kpi expects the layer's service count (from
   *  the landing aggregate's `serviceCount`) instead of an MQE
   *  result. The `mqe` field is filled with a placeholder so the
   *  request shape stays uniform; the value-pickup pass below treats
   *  it specially. */
  isServiceCount?: boolean;
}

/** One landing call's worth of requests. */
interface LayerGroup {
  layer: string;
  /** Page-side top-N window (the `topN` sent to the landing route). Self-
   *  aggregating groups ignore it (their columns fire once). */
  limit: number;
  reqs: MqeRequest[];
  /** Page-side ranking basis. `column` = sort by an existing column index;
   *  `mqe` = a standalone ranking metric (probed per service, sorted on,
   *  NOT displayed). Absent → rank by the first column. */
  rank?: { column?: number; mqe?: string };
}

/** Resolve a page-side widget's `rankBy` to a landing-column reference. An
 *  `mqe` passes straight through; a KPI index is mapped to its position
 *  among the widget's MQE (non-service-count) KPIs — a `service-count` KPI
 *  can't be ranked by, so that falls back to the first column. */
function resolveRank(w: OverviewWidget): LayerGroup['rank'] {
  const rb = w.rankBy;
  if (!rb) return undefined;
  if (rb.mqe) return { mqe: rb.mqe };
  if (rb.kpi != null && w.kpis) {
    const target = w.kpis[rb.kpi];
    if (target && (target.source ?? 'mqe') === 'mqe') {
      const column = w.kpis.slice(0, rb.kpi).filter((k) => (k.source ?? 'mqe') === 'mqe').length;
      return { column };
    }
  }
  return undefined;
}

/**
 * Group data-bound widgets into landing calls. Self-aggregating columns
 * batch by layer (they fire once and ignore topN/ranking). Each page-side
 * (`aggregateOnPage`) widget gets its OWN call — it carries its own `limit`
 * AND ranking, which a shared per-layer call couldn't honour. Section-
 * breaks, alarms, and topology widgets are skipped (no aggregate).
 */
function groupRequests(widgets: OverviewWidget[]): LayerGroup[] {
  const selfByLayer = new Map<string, LayerGroup>();
  const pageGroups: LayerGroup[] = [];
  for (const w of widgets) {
    const layer = w.layer;
    if (!layer) continue;
    if (w.type === 'section-break' || w.type === 'alarms' || w.type === 'topology') continue;
    // Self-aggregating unless the widget opts into page-side (fan-out)
    // aggregation. Service-count rows never fire an MQE, so the flag is
    // moot for them.
    const selfAggregate = !(w.aggregateOnPage ?? false);
    const reqs: MqeRequest[] = [];
    if (w.type === 'metric' && w.mqe) {
      reqs.push({
        widgetId: w.id,
        mqe: w.mqe,
        aggregation: w.aggregation ?? 'avg',
        unit: w.unit,
        selfAggregate,
      });
    } else if ((w.type === 'kpi-tile' || w.type === 'metric-composite') && w.kpis) {
      for (const k of w.kpis) {
        const isCount = k.source === 'service-count';
        reqs.push({
          widgetId: w.id,
          kpiLabel: k.label,
          mqe: isCount ? '__service_count' : (k.mqe ?? ''),
          aggregation: k.aggregation ?? 'avg',
          unit: k.unit,
          isServiceCount: isCount,
          selfAggregate: selfAggregate && !isCount,
        });
      }
    }
    if (reqs.length === 0) continue;
    if (w.aggregateOnPage) {
      pageGroups.push({ layer, limit: Math.min(8, Math.max(1, w.limit ?? 1)), reqs, rank: resolveRank(w) });
    } else {
      const g = selfByLayer.get(layer) ?? { layer, limit: 1, reqs: [] };
      g.reqs.push(...reqs);
      selfByLayer.set(layer, g);
    }
  }
  return [...selfByLayer.values(), ...pageGroups];
}

/**
 * Load one overview dashboard + its widget values. Topology widgets are
 * resolved by the consumer (TopologySnapshotWidget hits the per-layer
 * topology route directly) — this composable only fans out the MQE
 * aggregate calls.
 */
export function useOverviewDashboard(idRef: Ref<string>) {
  const dash = useQuery({
    queryKey: ['overview-dashboard', idRef],
    queryFn: () => bffClient.overview.get(idRef.value),
    enabled: computed(() => Boolean(idRef.value)),
    staleTime: 60_000,
  });

  // Preview overlay: when the admin opens this page in `?mode=preview`,
  // render the previewed source (local draft / bundled / remote snapshot)
  // instead of the fetched live remote — the same overlay the config
  // bundle applies to overview LIST views, so the admin Preview button
  // works on the detail page too. Both the rendered widgets AND the MQE
  // fan-out below read from this, so previewed metrics resolve live.
  const dashboard = computed<OverviewDashboard | null>(
    () =>
      getPreviewContentFor<OverviewDashboard>(overviewEditName(idRef.value)) ??
      dash.data.value?.dashboard ??
      null,
  );

  const widgets = computed<OverviewWidget[]>(() => dashboard.value?.widgets ?? []);
  const layerGroups = computed(() => groupRequests(widgets.value));

  // The topbar time picker is part of every overview query so flipping
  // the time / cold pills refires the per-layer landing calls instead
  // of serving the previous window's cached aggregates. We forward the
  // raw step+startMs+endMs to the BFF and also stamp them into the
  // queryKey for cache scoping.
  const timeRange = useTimeRangeStore();
  const rangeKey = computed(() => ({
    step: timeRange.step,
    startMs: timeRange.range.startMs,
    endMs: timeRange.range.endMs,
  }));

  // One landing call per (layer, page-limit) group — usually 1–3 total.
  const layerQueries = useQueries({
    queries: computed(() => {
      const range = rangeKey.value;
      return layerGroups.value.map((g) => ({
        // Key on the MQE column set (`reqs`) + the group's limit, not just
        // the overview id: a remote sync or preview edit that keeps the id
        // but changes a widget's MQE / limit must refire.
        queryKey: ['overview-dashboard-data', idRef.value, g.layer, g.limit, JSON.stringify(g.rank ?? null), range, JSON.stringify(g.reqs)],
        queryFn: () => {
          /* Service-count KPIs read from `aggregates.serviceCount`
           * — strip them from the MQE column list to avoid sending
           * a synthetic MQE upstream. They still ride in `reqs` so
           * the value-pickup pass below can inject the count. */
          const mqeReqs = g.reqs.filter((r) => !r.isServiceCount);
          // Columns are keyed by COLUMN id (`w_<idx>`), not the raw MQE — the
          // BFF stores per-row metrics under the column key.
          const columns: LandingConfig['columns'] = mqeReqs.map((r, i) => ({
            metric: `w_${i}`,
            label: r.kpiLabel ?? r.widgetId,
            mqe: r.mqe,
            aggregation: r.aggregation,
            unit: r.unit,
            selfAggregate: r.selfAggregate,
          }));
          // Ranking basis for the page-side top-N slice (default: first
          // column). `rank.column` sorts by an existing KPI column; `rank.mqe`
          // appends a ranking-ONLY column — fan-out probed + sorted on, but
          // never read back (the value pickup only maps w_0..w_{n-1}).
          let orderBy = 'w_0';
          if (g.rank?.mqe) {
            const rankKey = `w_${mqeReqs.length}`;
            columns.push({ metric: rankKey, label: '__rank', mqe: g.rank.mqe, aggregation: 'sum', selfAggregate: false });
            orderBy = rankKey;
          } else if (g.rank?.column != null) {
            orderBy = `w_${g.rank.column}`;
          }
          // priority is required by the LandingConfig type but ignored by
          // the BFF route (it forwards only topN/orderBy/columns).
          const cfg: LandingConfig = { priority: 0, topN: g.limit, orderBy, columns };
          return bffClient.layer.landing(g.layer, cfg, range).then((res) => ({
            layer: g.layer,
            reqs: g.reqs,
            mqeReqs,
            aggregates: res.aggregates,
          }));
        },
        staleTime: 30_000,
        refetchOnWindowFocus: true,
      }));
    }),
  });

  const values = computed<OverviewWidgetValues>(() => {
    const out: OverviewWidgetValues = { values: {}, kpiValues: {} };
    // metric / kpi-tile / metric-composite read their MQE
    // values out of the layer aggregate keyed by `w_<idx>`. KPI rows
    // with `source: 'service-count'` instead pick up the landing
    // aggregate's `serviceCount` directly.
    for (const q of layerQueries.value) {
      const data = q.data;
      if (!data) continue;
      const { reqs, mqeReqs, aggregates } = data;
      /* MQE rows map by position in `mqeReqs` (which is the only set
       * the BFF actually evaluated). Service-count rows below pick
       * up the count regardless of position. */
      mqeReqs.forEach((r, i) => {
        const v = aggregates.metrics[`w_${i}`] ?? null;
        if (r.kpiLabel) {
          if (!out.kpiValues[r.widgetId]) out.kpiValues[r.widgetId] = {};
          out.kpiValues[r.widgetId][r.kpiLabel] = v;
        } else {
          out.values[r.widgetId] = v;
        }
      });
      for (const r of reqs) {
        if (!r.isServiceCount || !r.kpiLabel) continue;
        if (!out.kpiValues[r.widgetId]) out.kpiValues[r.widgetId] = {};
        out.kpiValues[r.widgetId][r.kpiLabel] = aggregates.serviceCount;
      }
      // kpi-tile widgets with showCount=true pick up the layer's
      // service count for the slot above the KPI rows. Read from the
      // same landing aggregate — no separate listServices call.
      for (const w of widgets.value) {
        if (w.layer !== data.layer) continue;
        if (w.type === 'kpi-tile' && w.showCount) {
          out.values[w.id] = aggregates.serviceCount;
        }
      }
    }
    return out;
  });

  const isLoadingData = computed(() => layerQueries.value.some((q) => q.isLoading));

  return {
    isLoading: dash.isLoading,
    isLoadingData,
    isError: dash.isError,
    dashboard,
    widgets,
    values,
  };
}
