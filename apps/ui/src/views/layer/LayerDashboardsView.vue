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
  Per-layer Dashboards tab. Widget set + MQE expressions are seeded from
  the BFF (lifted from booster-ui's templates); widget data comes from a
  single POST /api/layer/:key/dashboard call scoped to the currently
  selected service.

  Cards (single-value KPIs) render with a big number + unit; line
  widgets render with a TimeChart wrapping ECharts. Grid layout uses
  24-column CSS grid coordinates matching booster-ui's vue-grid-layout
  so position + span port straight from the upstream templates.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import type { LayerDef } from '@skywalking-horizon-ui/api-client';
import TimeChart from '@/components/charts/TimeChart.vue';
import TopList from '@/components/charts/TopList.vue';
import { useLayerDashboard, useLayerDashboardConfig } from '@/composables/useLayerDashboard';
import { useLayerLanding } from '@/composables/useLayerLanding';
import { useLayers } from '@/composables/useLayers';
import { useSelectedService } from '@/composables/useSelectedService';
import { useSetupStore } from '@/stores/setup';
import { fmtMetric } from '@/utils/formatters';

const route = useRoute();
const layerKey = computed(() => String(route.params.layerKey ?? ''));
// Scope is inferred from the active sub-route (`service` / `instance`
// / `endpoint` / `trace` / `profiling`). The view is shared across
// all per-layer scope routes, the BFF returns a different widget set
// per scope.
const scope = computed<string>(() => {
  const path = route.path;
  for (const s of ['instance', 'endpoint', 'trace', 'profiling']) {
    if (path.endsWith(`/${s}`)) return s;
  }
  return 'service';
});
const { selectedId } = useSelectedService();
const { layers } = useLayers();
const layer = computed<LayerDef | null>(() => layers.value.find((l) => l.key === layerKey.value) ?? null);

const store = useSetupStore();
const safeLayer = computed<LayerDef>(() => layer.value ?? {
  key: layerKey.value, name: layerKey.value, color: 'var(--sw-fg-2)',
  serviceCount: -1, active: false, level: null, slots: {}, caps: {},
});
const safeCfg = computed(() => {
  if (!layer.value) return { priority: 99, topN: 5, orderBy: 'cpm', columns: [], style: 'table' as const };
  return store.ensure(layer.value.key, { slots: layer.value.slots, caps: layer.value.caps }).landing;
});
const landing = useLayerLanding(safeLayer, safeCfg);
const serviceName = computed<string | null>(() => {
  const rows = landing.data.value?.sampledRows ?? landing.rows.value ?? [];
  const match = rows.find((r) => r.serviceId === selectedId.value);
  return match?.serviceName ?? null;
});

const { config, isLoading: configLoading } = useLayerDashboardConfig(layerKey, scope);
const { data, isFetching, error } = useLayerDashboard(layerKey, serviceName, scope);

const widgets = computed(() => config.value?.widgets ?? []);
const resultsById = computed(() => {
  const out = new Map<string, NonNullable<typeof data.value>['widgets'][number]>();
  for (const r of data.value?.widgets ?? []) out.set(r.id, r);
  return out;
});
const reachable = computed(() => data.value?.reachable !== false);
const errorText = computed(() => data.value?.error ?? (error.value ? String(error.value) : null));

/** Map a widget's grid footprint into the new 12-col flow grid. Honors
 *  `span` / `rowSpan` first; falls back to legacy `w` / `h` (24-col
 *  scaled to 12 by halving) so older templates still render. */
function gridStyle(w: { span?: number; rowSpan?: number; w?: number; h?: number }): Record<string, string> {
  const span = w.span ?? (w.w ? Math.max(1, Math.min(12, Math.round(w.w / 2))) : 4);
  const rowSpan = w.rowSpan ?? (w.h ? Math.max(1, Math.round(w.h / 8)) : 1);
  return {
    gridColumn: `span ${span}`,
    gridRow: `span ${rowSpan}`,
  };
}

/**
 * Evaluate a widget's `visibleWhen` predicate.
 *   - `<metric_name> has value`  → the widget's result has a non-null
 *     scalar / a non-empty series.
 *   - `#entity.<key>`             → entity attribute exists (deferred —
 *     we don't surface entity attributes yet; defaults true).
 *   - anything else               → treated as "always visible".
 *
 * Empty / unset → always visible. Predicates that mention a metric not
 * in the widget's own results never hide the widget either; they're
 * advisory hints for the operator's mental model.
 */
function isVisible(
  w: { id: string; visibleWhen?: string },
  result: { value?: number | null; series?: Array<{ data: Array<number | null> }> } | undefined,
): boolean {
  const cond = w.visibleWhen?.trim();
  if (!cond) return true;
  const hasValueMatch = /^(\S+)\s+has\s+value$/i.exec(cond);
  if (hasValueMatch && result) {
    if (result.value !== undefined && result.value !== null) return true;
    if (result.series && result.series.some((s) => s.data.some((v) => v !== null))) return true;
    return false;
  }
  if (cond.startsWith('#entity.')) {
    // Entity-attribute predicates need an attributes feed we don't
    // surface yet (Phase 7-ish). Render the widget for now.
    return true;
  }
  return true;
}
</script>

<template>
  <div class="dash-tab">
    <header v-if="isFetching || !reachable" class="dash-head">
      <span v-if="isFetching" class="badge fetch">refreshing</span>
      <span v-else-if="!reachable" class="badge err">OAP unreachable</span>
    </header>

    <div v-if="!reachable" class="banner err">
      <strong>OAP unreachable.</strong>
      {{ errorText ?? 'Widgets are showing nothing — check the BFF is up and OAP is reachable.' }}
    </div>

    <div v-if="configLoading" class="empty">Loading dashboard config…</div>
    <div v-else-if="widgets.length === 0" class="empty">
      No widgets defined for this layer. Phase 7 admin will let operators add their own.
    </div>
    <div v-else class="grid">
      <div
        v-for="w in widgets.filter((wi) => isVisible(wi, resultsById.get(wi.id)))"
        :key="w.id"
        class="widget sw-card"
        :style="gridStyle(w)"
      >
        <div class="w-head" :title="w.tip">
          <h4>{{ w.title }}</h4>
          <span v-if="w.unit" class="unit">{{ w.unit }}</span>
        </div>
        <div class="w-body">
          <template v-if="resultsById.get(w.id)?.error">
            <span class="muted">{{ resultsById.get(w.id)!.error }}</span>
          </template>
          <template v-else-if="w.type === 'card'">
            <div class="card-value">
              <span class="num" :class="{ muted: resultsById.get(w.id)?.value == null }">
                {{ fmtMetric(resultsById.get(w.id)?.value ?? null) }}
              </span>
              <span v-if="w.unit" class="unit">{{ w.unit }}</span>
            </div>
          </template>
          <template v-else-if="w.type === 'line'">
            <TimeChart
              v-if="resultsById.get(w.id)?.series?.length"
              :series="resultsById.get(w.id)!.series!"
              :unit="w.unit"
              :height="(w.rowSpan ?? 1) * 160 - 60"
            />
            <span v-else class="muted">no data</span>
          </template>
          <template v-else-if="w.type === 'top'">
            <TopList
              v-if="resultsById.get(w.id)?.topList?.length"
              :items="resultsById.get(w.id)!.topList!"
              :unit="w.unit"
            />
            <span v-else class="muted">no data</span>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dash-tab {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 0 0;
}
.dash-head {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
}
.badge {
  font-size: 10px;
  padding: 3px 8px;
  border-radius: 999px;
  font-weight: 500;
}
.badge.ok {
  color: var(--sw-ok);
  background: rgba(34, 197, 94, 0.1);
}
.badge.fetch {
  color: var(--sw-info);
  background: rgba(96, 165, 250, 0.1);
}
.badge.err {
  color: var(--sw-err);
  background: rgba(239, 68, 68, 0.1);
}
.banner.err {
  padding: 8px 12px;
  background: var(--sw-err-soft);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  color: #f87171;
  font-size: 11.5px;
}
.empty {
  padding: 32px;
  text-align: center;
  color: var(--sw-fg-3);
  font-size: 12px;
}
.grid {
  /* 12-col flow grid with fixed row height. `grid-auto-flow: dense`
   * back-fills gaps so a span-12 widget after several span-4s doesn't
   * leave a hole. Widget heights are deliberately uniform — operators
   * vary span (width) more than rowSpan. */
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  grid-auto-rows: 180px;
  grid-auto-flow: row dense;
  gap: 12px;
}
.widget {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}
.w-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--sw-line);
}
.w-head h4 {
  margin: 0;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--sw-fg-0);
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.w-head .unit {
  font-size: 10px;
  color: var(--sw-fg-3);
  flex: 0 0 auto;
}
.w-body {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px 12px;
  min-height: 0;
  overflow: hidden;
}
.w-body :deep(.top-list) {
  align-self: stretch;
  justify-self: stretch;
}
.card-value {
  display: flex;
  align-items: baseline;
  gap: 4px;
}
.card-value .num {
  font-size: 26px;
  font-weight: 700;
  color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
}
.card-value .num.muted {
  color: var(--sw-fg-3);
}
.card-value .unit {
  font-size: 11px;
  color: var(--sw-fg-3);
}
.muted {
  color: var(--sw-fg-3);
  font-size: 11px;
}
.w-body :deep(.time-chart) {
  width: 100%;
}

@media (max-width: 1100px) {
  .grid {
    grid-template-columns: repeat(12, 1fr);
  }
  .widget {
    grid-column: span 12 !important;
  }
}
</style>
