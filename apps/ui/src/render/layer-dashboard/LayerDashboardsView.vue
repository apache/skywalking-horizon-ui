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
import { colorForMetric } from '@/utils/metricColor';
import { useLayerDashboard, useLayerDashboardConfig } from '@/render/layer-dashboard/useLayerDashboard';
import { useLayerPageOrchestrator } from '@/render/layer-dashboard/useLayerPageOrchestrator';
import { useLayerEndpoints } from '@/layer/useLayerEndpoints';
import { useLayerInstances } from '@/layer/useLayerInstances';
import { useLayerLanding } from '@/layer/useLayerLanding';
import { useLayers } from '@/shell/useLayers';
import { useSelectedEndpoint } from '@/layer/useSelectedEndpoint';
import { useSelectedInstance } from '@/layer/useSelectedInstance';
import { useSelectedService } from '@/layer/useSelectedService';
import { useSetupStore } from '@/state/setup';
import { fmtMetricAs } from '@/utils/formatters';
import { ref, watch, watchEffect } from 'vue';

const route = useRoute();
const layerKey = computed(() => String(route.params.layerKey ?? ''));
// Scope is inferred from the active sub-route. Profiling is split
// into three independent scopes (trace / eBPF / async), each with its
// own widget set on the layer template; the route segment is
// kebab-cased so the URL stays readable.
const ROUTE_TO_SCOPE: Record<string, string> = {
  instance: 'instance',
  endpoint: 'endpoint',
  trace: 'trace',
  logs: 'logs',
  topology: 'topology',
  dependency: 'dependency',
  'trace-profiling': 'traceProfiling',
  'ebpf-profiling': 'ebpfProfiling',
  'async-profiling': 'asyncProfiling',
};
const scope = computed<string>(() => {
  const path = route.path;
  for (const segment of Object.keys(ROUTE_TO_SCOPE)) {
    if (path.endsWith(`/${segment}`)) return ROUTE_TO_SCOPE[segment];
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
  return store.ensure(layer.value.key, { slots: layer.value.slots, caps: layer.value.caps, metrics: layer.value.metrics, overview: layer.value.overview }).landing;
});
const landing = useLayerLanding(safeLayer, safeCfg);
const serviceName = computed<string | null>(() => {
  const rows = landing.data.value?.sampledRows ?? landing.rows.value ?? [];
  const match = rows.find((r) => r.serviceId === selectedId.value);
  return match?.serviceName ?? null;
});
/**
 * Service handle used for downstream picker queries (instance list,
 * endpoint list, dashboard widgets). The landing route resolves
 * `selectedId` → `serviceName` once its row sample arrives, which can
 * take a moment on first paint. The BFF picker / dashboard routes
 * accept either a name OR an id, so we fire those queries with
 * `selectedId` immediately and let `serviceName` overtake when ready.
 * Avoids the "instance list empty for a beat after landing" hiccup
 * the operator reported.
 */
const serviceHandle = computed<string | null>(
  () => serviceName.value ?? selectedId.value ?? null,
);

// Dev-only escape hatch: appending `?mockTop=10` to the page URL pads
// every TopList result to N synthetic rows. Helps operators verify
// widget heights without waiting for OAP to populate the layer.
const mockTop = computed<number>(() => {
  const v = route.query.mockTop;
  if (typeof v !== 'string') return 0;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(40, n) : 0;
});

const { config, isLoading: configLoading } = useLayerDashboardConfig(layerKey, scope);

// Instance selection: only meaningful on the Instance scope, but the
// selector renders whenever a service is picked AND scope === instance.
// Cleared automatically when the service changes so a stale instance
// from a previous service doesn't bleed into the next one's queries.
const { selectedInstance, setSelectedInstance } = useSelectedInstance();
const { instances: instanceList, isFetching: instancesLoading } = useLayerInstances(
  layerKey,
  serviceHandle,
);
/** Track which row's attributes panel is open. Mutually exclusive —
 *  expanding one collapses the previous so the list stays compact. */
const expandedInstance = ref<string | null>(null);

/** Auto-pick the first available service whenever the operator lands
 *  on the page with no service selected — applies to every scope, not
 *  just `instance`. The dashboard query is gated on `service.value`
 *  (so it doesn't fire with `null` and re-fetch on resolve), and the
 *  instance / endpoint feeds need an explicit service too. Without
 *  this auto-pick on the Service scope, layers like Virtual MQ /
 *  Virtual Database stayed empty until the operator manually clicked
 *  the service picker — the first service has data, we just hadn't
 *  bound to it. */
const { setSelected: setSelectedService } = useSelectedService();
const landingRows = computed(() => landing.data.value?.sampledRows ?? landing.rows.value ?? []);
watch(landingRows, (rows) => {
  const first = rows[0];
  if (!first) return;
  if (!selectedId.value || !rows.some((r) => r.serviceId === selectedId.value)) {
    setSelectedService(first.serviceId);
  }
}, { immediate: true });
// Drop the stale instance whenever the service changes — the new
// service's instance list almost never matches the previous pick.
watch(serviceName, (next, prev) => {
  if (prev !== undefined && next !== prev && selectedInstance.value) {
    setSelectedInstance(null);
  }
});
// Default-select the first instance once the list arrives, but only
// on the Instance scope (so other scopes don't bake an instance into
// their URL on every visit).
watch([instanceList, scope], ([list, s]) => {
  if (s !== 'instance') return;
  if (list.length === 0) {
    if (selectedInstance.value) setSelectedInstance(null);
    return;
  }
  if (!selectedInstance.value || !list.some((i) => i.name === selectedInstance.value)) {
    setSelectedInstance(list[0].name);
  }
});

// Endpoint selection — same pattern as instance, with a keyword
// search box driving findEndpoint(...). Endpoints are unbounded so
// there's no full-page paging; the picker is top 20…50. Search fires
// on Enter (not on every keystroke) so the operator can type a
// multi-word query without watching the BFF re-query each character.
const { selectedEndpoint, setSelectedEndpoint } = useSelectedEndpoint();
/** Live text in the input — bound via v-model. */
const endpointSearchInput = ref('');
/** Committed keyword that actually drives the BFF query. Updated on
 *  Enter / blur via submitEndpointSearch(). */
const endpointQuery = ref('');
const endpointLimit = ref(20);
function submitEndpointSearch(): void {
  endpointQuery.value = endpointSearchInput.value.trim();
}
function clearEndpointSearch(): void {
  endpointSearchInput.value = '';
  endpointQuery.value = '';
}
const { endpoints: endpointList, isFetching: endpointsLoading } = useLayerEndpoints(
  layerKey,
  serviceHandle,
  endpointQuery,
  endpointLimit,
);
// Endpoint-scope orchestration — explicit sequence so the loading
// flow is deterministic:
//   1. wait for landing rows
//   2. pick the first service when none is selected
//   3. wait for that service's endpoint list to arrive (`endpointQuery`
//      starts empty → BFF returns the recent top-N immediately)
//   4. pick the first endpoint when none is selected
// `watchEffect` re-fires on each dependency change and the early
// `return` after step 2 ensures we don't try to pick an endpoint
// before `serviceName` has propagated to `useLayerEndpoints` and the
// list has refreshed for the new service.
watchEffect(() => {
  if (scope.value !== 'endpoint') return;
  if (!selectedId.value) {
    const first = landingRows.value[0];
    if (first) setSelectedService(first.serviceId);
    return;
  }
  if (selectedEndpoint.value) return;
  if (endpointsLoading.value) return;
  const first = endpointList.value[0];
  if (first) setSelectedEndpoint(first.name);
});
// Drop stale endpoint when service changes.
watch(serviceName, (next, prev) => {
  if (prev !== undefined && next !== prev && selectedEndpoint.value) {
    setSelectedEndpoint(null);
  }
});
// Default-selection of the first endpoint happens inside the
// `watchEffect` above so the service → endpoint sequence is
// deterministic; no separate watch needed here.

const { data, isFetching, error } = useLayerDashboard(
  layerKey,
  serviceName,
  scope,
  mockTop,
  { instance: selectedInstance, endpoint: selectedEndpoint },
);

// Sequential page-init events for the EventTicker — config →
// services → service → instances/endpoints → instance/endpoint →
// dashboard. The orchestrator watches the refs above and emits one
// numbered step at a time, so the ticker reads top-to-bottom in
// dependency order even when the underlying vue-queries race.
useLayerPageOrchestrator({
  layerKey,
  scope,
  config,
  serviceList: landingRows,
  effectiveService: serviceName,
  instanceList,
  effectiveInstance: selectedInstance,
  endpointList,
  effectiveEndpoint: selectedEndpoint,
  dashboard: data,
});

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
 * Resolve a widget's primary metric color from its title / id / first
 * expression. Same color scheme as the layer-header KPI strip so
 * Apdex shows purple, Traffic orange, p99 yellow, err red across both
 * surfaces — the operator builds one mental color map.
 */
function widgetColor(w: { id?: string; title?: string; expressions?: string[] }): string {
  // Try a few sources in priority order; the colorForMetric helper
  // pattern-matches on the metric key (cpm / sla / apdex / err /
  // p50/p75/p95/p99 / etc.) — the title or id usually contains one.
  const candidates: string[] = [];
  if (w.id) candidates.push(w.id);
  if (w.title) candidates.push(w.title);
  if (w.expressions?.[0]) candidates.push(w.expressions[0]);
  // Lower-case + flatten so patterns like 'service_cpm' / 'Traffic'
  // both hit the right band.
  for (const c of candidates) {
    const c2 = c.toLowerCase();
    if (/(^|[^a-z])cpm([^a-z]|$)/.test(c2) || c2.includes('traffic') || c2.includes('rpm')) return 'var(--sw-accent)';
    if (c2.includes('apdex')) return 'var(--sw-purple)';
    if (c2.includes('sla') || c2.includes('success')) return 'var(--sw-purple)';
    if (/p\d{2,3}/.test(c2) || c2.includes('percentile') || c2.includes('resp_time') || c2.includes('response time') || c2.includes('latency')) return 'var(--sw-warn)';
    if (c2.includes('err') || c2.includes('error') || c2.includes('failure')) return 'var(--sw-err)';
  }
  // Fall back to the metric catalog helper.
  return colorForMetric(w.id || w.title || w.expressions?.[0] || '');
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
  result:
    | {
        value?: number | null;
        series?: Array<{ data: Array<number | null> }>;
        topList?: Array<unknown>;
        topGroups?: Array<{ items: Array<unknown> }>;
        records?: Array<unknown>;
      }
    | undefined,
): boolean {
  const cond = w.visibleWhen?.trim();
  if (!cond) return true;
  const hasValueMatch = /^(\S+)\s+has\s+value$/i.exec(cond);
  if (hasValueMatch && result) {
    if (result.value !== undefined && result.value !== null) return true;
    if (result.series && result.series.some((s) => s.data.some((v) => v !== null))) return true;
    // Top + record widgets: a non-empty list counts as "has value".
    // Without these checks, every gated `top` / `record` widget would
    // hide itself the moment the BFF returns its rows, since neither
    // .value nor .series is populated.
    if (result.topList && result.topList.length > 0) return true;
    if (result.topGroups && result.topGroups.some((g) => g.items.length > 0)) return true;
    if (result.records && result.records.length > 0) return true;
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

    <!-- Instance picker — a sticky list on the left when the Instance
         scope is active. Each row shows the instance name, language
         tag, and an expandable attributes property list. Auto-fires
         once a service is selected (no manual trigger). When no
         service is picked, we show a hint and gate the widget grid
         so a stale instance can't sneak into queries. -->
    <section v-if="scope === 'instance'" class="instance-bar sw-card">
      <header class="ib-head">
        <span class="kicker">Instance</span>
        <span v-if="serviceName" class="for-svc">
          for <b>{{ serviceName }}</b>
          <span v-if="instanceList.length > 0" class="count">{{ instanceList.length }}</span>
        </span>
        <span v-if="instancesLoading" class="hint">loading…</span>
      </header>
      <div v-if="!serviceName" class="empty inline">
        Pick a service in the picker above to list its instances.
      </div>
      <div v-else-if="!instancesLoading && instanceList.length === 0" class="empty inline">
        No active instances reported for {{ serviceName }} in the last 15 minutes.
      </div>
      <ul v-else class="ib-list">
        <li
          v-for="i in instanceList"
          :key="i.id"
          class="ib-row"
          :class="{ on: selectedInstance === i.name }"
        >
          <button
            type="button"
            class="ib-pick-btn"
            @click="setSelectedInstance(i.name)"
          >
            <span class="ib-name">{{ i.name }}</span>
            <span v-if="i.language" class="ib-lang">{{ i.language }}</span>
          </button>
          <button
            v-if="i.attributes.length > 0"
            type="button"
            class="ib-expand"
            :title="expandedInstance === i.id ? 'Collapse attributes' : 'Show attributes'"
            @click="expandedInstance = expandedInstance === i.id ? null : i.id"
          >
            <span class="caret" :class="{ open: expandedInstance === i.id }">▸</span>
            {{ i.attributes.length }} attr
          </button>
          <dl v-if="expandedInstance === i.id" class="ib-attrs">
            <template v-for="a in i.attributes" :key="a.name">
              <dt>{{ a.name }}</dt>
              <dd>{{ a.value || '—' }}</dd>
            </template>
          </dl>
        </li>
      </ul>
    </section>

    <!-- Endpoint picker — same vertical-list shape as Instance, with
         a search input at the top driving findEndpoint. Endpoints
         are unbounded so we don't page through them; the BFF clamps
         the limit to 20…50. -->
    <section v-if="scope === 'endpoint'" class="instance-bar sw-card">
      <header class="ib-head">
        <span class="kicker">Endpoint</span>
        <span v-if="serviceName" class="for-svc">
          for <b>{{ serviceName }}</b>
          <span v-if="endpointList.length > 0" class="count">{{ endpointList.length }}</span>
        </span>
        <span v-if="endpointsLoading" class="hint">loading…</span>
      </header>
      <div v-if="!serviceName" class="empty inline">
        Pick a service in the picker above to search its endpoints.
      </div>
      <template v-else>
        <div class="ep-controls">
          <input
            class="ep-search"
            type="search"
            placeholder="Search endpoints, press Enter…"
            v-model="endpointSearchInput"
            @keydown.enter.prevent="submitEndpointSearch"
            @search="submitEndpointSearch"
          />
          <button
            class="sw-btn small"
            type="button"
            :disabled="endpointSearchInput === endpointQuery"
            title="Run the search (Enter)"
            @click="submitEndpointSearch"
          >Search</button>
          <button
            v-if="endpointQuery"
            class="sw-btn ghost small"
            type="button"
            title="Clear the search keyword"
            @click="clearEndpointSearch"
          >Clear</button>
          <label class="ep-limit" title="Endpoints are unbounded — limit clamps the top-N (20–50).">
            <span>Top</span>
            <select v-model.number="endpointLimit">
              <option :value="20">20</option>
              <option :value="30">30</option>
              <option :value="40">40</option>
              <option :value="50">50</option>
            </select>
          </label>
        </div>
        <div v-if="endpointQuery" class="ep-active-query">
          Showing top {{ endpointLimit }} matches for
          <code>{{ endpointQuery }}</code>
        </div>
        <div v-if="!endpointsLoading && endpointList.length === 0" class="empty inline">
          No endpoints match
          <code v-if="endpointQuery">{{ endpointQuery }}</code>
          <span v-else>this service in the last 15 minutes</span>.
        </div>
        <ul v-else class="ib-list">
          <li
            v-for="e in endpointList"
            :key="e.id"
            class="ib-row"
            :class="{ on: selectedEndpoint === e.name }"
          >
            <button
              type="button"
              class="ib-pick-btn"
              @click="setSelectedEndpoint(e.name)"
            >
              <span class="ib-name">{{ e.name }}</span>
            </button>
          </li>
        </ul>
      </template>
    </section>

    <div v-if="configLoading" class="empty">Loading dashboard config…</div>
    <div
      v-else-if="scope === 'endpoint' && serviceName && !selectedEndpoint"
      class="empty"
    >
      Select an endpoint above to view its metrics.
    </div>
    <div
      v-else-if="scope === 'instance' && serviceName && !selectedInstance"
      class="empty"
    >
      Select an instance above to view its metrics.
    </div>
    <div v-else-if="widgets.length === 0" class="empty">
      No widgets defined for this layer. Phase 7 admin will let operators add their own.
    </div>
    <div v-else class="grid">
      <div
        v-for="w in widgets.filter((wi) => isVisible(wi, resultsById.get(wi.id)))"
        :key="w.id"
        class="widget sw-card"
        :style="{ ...gridStyle(w), '--widget-accent': widgetColor(w) }"
      >
        <div class="w-head" :title="w.tip">
          <h4>{{ w.title }}</h4>
          <span v-if="w.unit" class="unit">{{ w.unit }}</span>
        </div>
        <div class="w-body" :class="`type-${w.type}`">
          <template v-if="resultsById.get(w.id)?.error">
            <span class="muted">{{ resultsById.get(w.id)!.error }}</span>
          </template>
          <template v-else-if="w.type === 'card'">
            <div class="card-value">
              <span class="num" :class="{ muted: resultsById.get(w.id)?.value == null }">
                {{ fmtMetricAs(resultsById.get(w.id)?.value ?? null, w.format) }}
              </span>
              <span v-if="w.unit" class="unit">{{ w.unit }}</span>
            </div>
          </template>
          <template v-else-if="w.type === 'line'">
            <TimeChart
              v-if="resultsById.get(w.id)?.series?.length"
              :series="resultsById.get(w.id)!.series!"
              :unit="w.unit"
              :height="(w.rowSpan ?? 1) * 110 - 50"
              :accent="widgetColor(w)"
              :format="w.format"
            />
            <span v-else class="muted">no data</span>
          </template>
          <template v-else-if="w.type === 'top'">
            <TopList
              v-if="resultsById.get(w.id)?.topGroups?.length"
              :groups="resultsById.get(w.id)!.topGroups!"
              :unit="w.unit"
              :color="widgetColor(w)"
            />
            <TopList
              v-else-if="resultsById.get(w.id)?.topList?.length"
              :items="resultsById.get(w.id)!.topList!"
              :unit="w.unit"
              :color="widgetColor(w)"
            />
            <span v-else class="muted">no data</span>
          </template>
          <template v-else-if="w.type === 'record'">
            <!-- Slow-statement / record table — reuses the TopList
                 renderer since the shape (name + value) is identical.
                 Future runtime work will add trace-id drill-in. -->
            <TopList
              v-if="resultsById.get(w.id)?.records?.length"
              :items="resultsById.get(w.id)!.records!.map((r) => ({ name: r.name, value: r.value ?? null }))"
              :unit="w.unit"
              :color="widgetColor(w)"
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
.instance-bar {
  padding: 0;
  display: flex;
  flex-direction: column;
  max-height: 360px;
}
.ib-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
}
.ib-head .kicker {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sw-accent);
  font-weight: 600;
}
.ib-head .for-svc {
  font-size: 11px;
  color: var(--sw-fg-3);
}
.ib-head .for-svc b {
  color: var(--sw-fg-1);
  font-weight: 500;
  font-family: var(--sw-mono);
}
.ib-head .count {
  font-family: var(--sw-mono);
  font-size: 10px;
  padding: 1px 6px;
  margin-left: 6px;
  background: var(--sw-bg-2);
  color: var(--sw-fg-2);
  border-radius: 3px;
}
.ib-head .hint {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.empty.inline {
  padding: 18px;
  font-size: 11px;
}
.ib-list {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.ib-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 4px 8px;
  padding: 2px 10px;
  border-bottom: 1px solid var(--sw-line);
}
.ib-row:last-child { border-bottom: none; }
.ib-row.on {
  background: var(--sw-accent-soft);
}
.ib-pick-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--sw-fg-1);
  font: inherit;
  font-family: var(--sw-mono);
  font-size: 11.5px;
  text-align: left;
  cursor: pointer;
  min-width: 0;
}
.ib-pick-btn:hover {
  background: var(--sw-bg-2);
  color: var(--sw-fg-0);
}
.ib-row.on .ib-pick-btn {
  color: var(--sw-accent-2);
  font-weight: 600;
  background: transparent;
}
.ib-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ib-lang {
  flex: 0 0 auto;
  font-size: 9.5px;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--sw-bg-3);
  color: var(--sw-fg-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.ib-row.on .ib-lang {
  background: var(--sw-accent-line);
  color: var(--sw-accent-2);
}
.ib-expand {
  align-self: center;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px;
  background: transparent;
  border: none;
  border-radius: 3px;
  color: var(--sw-fg-3);
  font: inherit;
  font-size: 10px;
  cursor: pointer;
}
.ib-expand:hover {
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
}
.ib-expand .caret {
  display: inline-block;
  width: 9px;
  transition: transform 0.12s;
  font-size: 9px;
}
.ib-expand .caret.open {
  transform: rotate(90deg);
}
.ib-attrs {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 2px 12px;
  margin: 4px 8px 6px 18px;
  padding: 6px 10px;
  background: var(--sw-bg-2);
  border-radius: 4px;
  font-size: 10.5px;
}
.ib-attrs dt {
  color: var(--sw-fg-3);
  font-family: var(--sw-mono);
}
.ib-attrs dd {
  margin: 0;
  color: var(--sw-fg-1);
  font-family: var(--sw-mono);
  word-break: break-all;
}

/* Endpoint picker controls — search box + top-N limit selector,
 * laid out as a row above the endpoint list. */
.ep-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px 8px;
  border-bottom: 1px solid var(--sw-line);
}
.ep-search {
  flex: 1;
  height: 26px;
  padding: 0 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11.5px;
}
.ep-search:focus {
  outline: none;
  border-color: var(--sw-accent-line);
}
.ep-limit {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.ep-limit select {
  height: 26px;
  padding: 0 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11.5px;
}
.ep-active-query {
  padding: 4px 12px;
  font-size: 10.5px;
  color: var(--sw-fg-3);
  border-bottom: 1px dashed var(--sw-line);
}
.ep-active-query code {
  font-family: var(--sw-mono);
  font-size: 10.5px;
  color: var(--sw-accent-2);
  padding: 0 4px;
  background: var(--sw-accent-soft);
  border-radius: 2px;
}
.grid {
  /* 12-col flow grid with fixed row height. `grid-auto-flow: dense`
   * back-fills gaps so a span-12 widget after several span-4s doesn't
   * leave a hole. Row height tuned smaller so 2-row line widgets fit
   * comfortably without dwarfing the rest of the page. */
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  grid-auto-rows: 120px;
  grid-auto-flow: row dense;
  gap: 10px;
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
  padding: 5px 10px;
  border-bottom: 1px solid var(--sw-line);
  /* Subtle left-edge accent tinted to the widget's primary metric
   * color — ties each card to the matching KPI in the layer header. */
  border-left: 3px solid var(--widget-accent, var(--sw-accent));
}
.w-head h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--widget-accent, var(--sw-fg-0));
  letter-spacing: -0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.w-head .unit {
  font-size: 10.5px;
  color: var(--sw-fg-3);
  flex: 0 0 auto;
}
.w-body {
  /* Column-flex so charts / lists / records can flex: 1 and claim the
   * full widget height. Card-type widgets opt into centering via the
   * `.type-card` modifier (single scalar number reads better when
   * vertically centered). */
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 8px 12px;
  min-height: 0;
  overflow: hidden;
}
.w-body.type-card {
  align-items: center;
  justify-content: center;
}
.w-body :deep(.top-list) {
  flex: 1;
  min-height: 0;
}
.w-body :deep(.top-list .rows) {
  /* Inside TopList, the .rows wrapper already has `flex: 1` + scroll —
   * but it needs an explicit `min-height: 0` so the rows region can
   * shrink past its intrinsic content height when the widget is
   * shorter than the data. Without this, a 3-row-span widget renders
   * all 10 rows uncropped and the chrome distorts. */
  min-height: 0;
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
