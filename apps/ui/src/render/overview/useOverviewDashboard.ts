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
  /** When set, the widget+kpi expects the layer's service count (from
   *  the landing aggregate's `serviceCount`) instead of an MQE
   *  result. The `mqe` field is filled with a placeholder so the
   *  request shape stays uniform; the value-pickup pass below treats
   *  it specially. */
  isServiceCount?: boolean;
}

/**
 * Group every data-bound widget by its `layer`. Section-breaks, alarms,
 * and topology widgets are skipped (no aggregate to evaluate).
 */
function groupByLayer(widgets: OverviewWidget[]): Map<string, MqeRequest[]> {
  const out = new Map<string, MqeRequest[]>();
  for (const w of widgets) {
    const layer = w.layer;
    if (!layer) continue;
    if (w.type === 'section-break' || w.type === 'alarms' || w.type === 'topology') continue;
    if (w.type === 'metric' && w.mqe) {
      const reqs = out.get(layer) ?? [];
      reqs.push({
        widgetId: w.id,
        mqe: w.mqe,
        aggregation: w.aggregation ?? 'avg',
        unit: w.unit,
      });
      out.set(layer, reqs);
      continue;
    }
    if ((w.type === 'kpi-tile' || w.type === 'metric-composite') && w.kpis) {
      const reqs = out.get(layer) ?? [];
      for (const k of w.kpis) {
        const isCount = k.source === 'service-count';
        reqs.push({
          widgetId: w.id,
          kpiLabel: k.label,
          mqe: isCount ? '__service_count' : (k.mqe ?? ''),
          aggregation: k.aggregation ?? 'avg',
          unit: k.unit,
          isServiceCount: isCount,
        });
      }
      out.set(layer, reqs);
    }
  }
  return out;
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
  const layerRequests = computed(() => groupByLayer(widgets.value));

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

  // One landing call per referenced layer. Bundling all that layer's
  // MQEs in one request keeps the round-trip count to N, where N is the
  // distinct layer count in the dashboard — usually 1–3.
  const layerQueries = useQueries({
    queries: computed(() => {
      const entries = Array.from(layerRequests.value.entries());
      const range = rangeKey.value;
      return entries.map(([layer, reqs]) => ({
        // Include the MQE column set (`reqs`), not just the overview id:
        // a remote sync or preview edit that keeps the id but changes a
        // widget's MQE must refire, or the cache serves stale data.
        queryKey: ['overview-dashboard-data', idRef.value, layer, range, JSON.stringify(reqs)],
        queryFn: () => {
          /* Service-count KPIs read from `aggregates.serviceCount`
           * — strip them from the MQE column list to avoid sending
           * a synthetic MQE upstream. They still ride in `reqs` so
           * the value-pickup pass below can inject the count. */
          const mqeReqs = reqs.filter((r) => !r.isServiceCount);
          // priority + style are required by the LandingConfig type
          // but ignored by the BFF route — the client only forwards
          // topN/orderBy/columns. Stubbed to satisfy the type.
          const cfg: LandingConfig = {
            priority: 0,
            style: 'table',
            topN: 1,
            orderBy: mqeReqs[0]?.mqe ?? 'service_cpm',
            columns: mqeReqs.map((r, i) => ({
              metric: `w_${i}`,
              label: r.kpiLabel ?? r.widgetId,
              mqe: r.mqe,
              aggregation: r.aggregation,
              unit: r.unit,
            })),
          };
          return bffClient.layer.landing(layer, cfg, range).then((res) => ({
            layer,
            reqs,
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
