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
import { useRoute, useRouter } from 'vue-router';
import type { LayerDef, DashboardWidget } from '@skywalking-horizon-ui/api-client';
import FloatingPanel from '@/components/primitives/FloatingPanel.vue';
import type { TabHostCtx } from '@/render/widgets/tabHostCtx';
import LayerInstancePicker from '@/render/layer-dashboard/LayerInstancePicker.vue';
import LayerEndpointPicker from '@/render/layer-dashboard/LayerEndpointPicker.vue';
import LayerWidgetTile from '@/render/layer-dashboard/LayerWidgetTile.vue';
import { colorForMetric } from '@/utils/metricColor';
import { useLayerDashboard, useLayerDashboardConfig } from '@/render/layer-dashboard/useLayerDashboard';
import { useLayerPageOrchestrator } from '@/render/layer-dashboard/useLayerPageOrchestrator';
import { useInstanceCascade } from '@/render/layer-dashboard/useInstanceCascade';
import { useEndpointCascade } from '@/render/layer-dashboard/useEndpointCascade';
import { useCompareEngine } from '@/render/layer-dashboard/useCompareEngine';
import { useLayerServices } from '@/layer/useLayerServices';
import { useLayerLanding } from '@/layer/useLayerLanding';
import { useTimeRangeStore } from '@/controls/timeRange';
import { useLayers } from '@/shell/useLayers';
import { useSelectedService } from '@/layer/useSelectedService';
import { useLayerServiceName } from '@/layer/useLayerServiceName';
import { useSetupStore } from '@/state/setup';
import { bucketTimeLabel, fmtMetricAs, type MetricFormat } from '@/utils/formatters';
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { type CompareScope, compoundKey } from '@/state/layerSelection';

const { t } = useI18n({ useScope: 'global' });

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
const { selectedId, lockedServiceIds } = useSelectedService();
const { layers } = useLayers();
const layer = computed<LayerDef | null>(() => layers.value.find((l) => l.key === layerKey.value) ?? null);

const store = useSetupStore();
const safeLayer = computed<LayerDef>(() => layer.value ?? {
  key: layerKey.value, name: layerKey.value, color: 'var(--sw-fg-2)',
  serviceCount: -1, active: false, level: null, slots: {}, caps: {},
});
// Card display string. `format: 'enum'` looks the rounded value up in
// `valueMap`; labels are localized BFF-side (overlay deep-merge), rendered
// as-is with no client t(). Otherwise the number is formatted.
function cardText(w: { id: string; format?: MetricFormat; valueMap?: Record<string, string> }): string {
  const v = resultsById.value.get(w.id)?.value ?? null;
  if (v != null && w.format === 'enum' && w.valueMap) {
    const label = w.valueMap[String(Math.round(v))];
    if (label != null) return label;
  }
  return fmtMetricAs(v, w.format);
}
const safeCfg = computed(() => {
  if (!layer.value) return { priority: 99, topN: 5, orderBy: 'cpm', columns: [], style: 'table' as const };
  return store.ensure(layer.value.key, { slots: layer.value.slots, caps: layer.value.caps, metrics: layer.value.metrics, overview: layer.value.overview }).landing;
});
// Global time-range — picker change refires the landing rollup
// AND the widget batch via queryKey. Each downstream control
// listens to its upstream picker the same way it listens to
// service/instance/endpoint changes.
const timeRange = useTimeRangeStore();
const rangeRef = computed(() => {
  const r = timeRange.range;
  return { step: timeRange.step, startMs: r.startMs, endMs: r.endMs };
});

// Time-axis labels for line widgets. The BFF returns bucket VALUES only
// (no per-bucket timestamp), so we reconstruct evenly-spaced labels from
// the active window + step — the buckets are uniform, so spacing N points
// across [start, end] matches OAP's bucketing. Formatted browser-local
// (the app displays browser-local; ECharts handles ms→local elsewhere).
function xLabelsForLen(len: number): string[] {
  if (len <= 0) return [];
  const { startMs, endMs } = timeRange.range;
  const step = timeRange.step;
  if (len === 1) return [bucketTimeLabel(step, endMs)];
  return Array.from({ length: len }, (_, i) =>
    bucketTimeLabel(step, startMs + ((endMs - startMs) * i) / (len - 1)),
  );
}
const landing = useLayerLanding(safeLayer, safeCfg, rangeRef);
// Prefer landing rows for the selected service's name, falling back to
// the full roster for low-traffic / deep-linked services that miss
// landing's top-N — without it the dashboard would sit on "Resolving
// service…" forever. Shared with every other layer tab.
const serviceName = useLayerServiceName(layerKey, landing);
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
// Full service roster (all ids→names) — resolves cohort labels for
// locked services beyond the landing top-N sample.
const { services: serviceRoster } = useLayerServices(layerKey);
watch(landingRows, (rows) => {
  const first = rows[0];
  if (!first) return;
  // First-visit (no ?service= in URL) → quietly auto-pick the first
  // landing service so the page renders something. Stale-id recovery
  // for URL-pinned services is handled at the shell level
  // (LayerShell pops a "service not found" modal against the full
  // roster) so the dashboard doesn't second-guess a valid id that
  // simply missed landing's top-N rollup.
  if (!selectedId.value) {
    setSelectedService(first.serviceId);
    return;
  }
}, { immediate: true });
// Instance + endpoint picker cascades — each owns its list fetch,
// auto-pick / fallback, service-change reset, and `effective*` gate
// (see useInstanceCascade / useEndpointCascade for the full rationale).
const {
  selectedInstance,
  setSelectedInstance,
  lockedInstanceNames,
  toggleLockInstance,
  isInstanceLocked,
  instanceList,
  instancesLoading,
  instanceBadge,
  effectiveInstance,
  instanceResolvable,
  instAtCap,
} = useInstanceCascade(layerKey, scope, serviceName, layer);
const {
  selectedEndpoint,
  setSelectedEndpoint,
  lockedEndpointNames,
  toggleLockEndpoint,
  isEndpointLocked,
  endpointSearchInput,
  endpointQuery,
  endpointLimit,
  submitEndpointSearch,
  clearEndpointSearch,
  endpointList,
  endpointsLoading,
  effectiveEndpoint,
  endpointResolvable,
  epAtCap,
} = useEndpointCascade(layerKey, scope, serviceName, selectedId, landingRows, setSelectedService);
// Suppress the reset-then-load overlay when the picker's entity list
// settles EMPTY (no instance/endpoint can ever be picked, so the
// dashboard query never fires) — `*Resolvable` (from the cascades)
// stays true while a list / pin lookup is still in flight.
const noEntityToChart = computed<boolean>(() => {
  if (!serviceName.value) return false; // service still resolving — keep waiting
  if (scope.value === 'instance') return !instanceResolvable.value;
  if (scope.value === 'endpoint') return !endpointResolvable.value;
  return false;
});
// Active tab per `tab`-type widget (by widget id; default first tab). Owned
// here because it drives the lazy flatten below — only the active tab's
// widgets are queried. Declared above its consumer (widgetsForQuery) per the
// TDZ rule.
const activeTabByWidget = ref<Record<string, number>>({});
function activeTabIndex(widgetId: string): number {
  return activeTabByWidget.value[widgetId] ?? 0;
}
/** Clamp a stored active-tab index to the widget's current tab count. The index
 *  persists by widget id and a different scope template may reuse the same id
 *  with fewer tabs, leaving it out of range — clamp so the query, the rendered
 *  panel, and TabWidget's highlight all agree on the same tab. */
function clampedTabIndex(w: DashboardWidget): number {
  const n = w.tabs?.length ?? 0;
  if (n === 0) return 0;
  return Math.min(Math.max(activeTabIndex(w.id), 0), n - 1);
}
function activeTabWidgets(w: DashboardWidget): DashboardWidget[] {
  if (w.type !== 'tab') return [];
  return w.tabs?.[clampedTabIndex(w)]?.widgets ?? [];
}
function setActiveTab(widgetId: string, index: number): void {
  activeTabByWidget.value = { ...activeTabByWidget.value, [widgetId]: index };
}
// Lazy flatten: a `tab` widget contributes ONLY its active tab's widgets to
// the metrics request, so inactive tabs never hit OAP. Switching a tab changes
// this list → the query refires for the newly-active tab's widgets (vue-query
// keeps the prior response via keepPreviousData, so siblings don't blink and
// switching back is instant). A half-authored leaf (blank MQE) is dropped from
// the batch — the BFF rejects an empty expression and would 400 the whole
// scope; the widget still renders (as "no data"), it just isn't queried.
const widgetsForQuery = computed<DashboardWidget[]>(() =>
  (config.value?.widgets ?? [])
    .flatMap((w) => (w.type === 'tab' ? activeTabWidgets(w) : [w]))
    .map((w) => ({ ...w, expressions: (w.expressions ?? []).filter((e) => e.trim().length > 0) }))
    .filter((w) => w.expressions.length > 0),
);
// Hold the metrics fetch until the config bundle has resolved WITH widgets.
// A resolved-but-empty config means "no dashboard for this layer/scope",
// so we don't fire (which would otherwise make the BFF substitute its own
// default widget set); metrics run only for resolved widgets.
const configReady = computed(() => widgetsForQuery.value.length > 0);

// Multi-entity compare. The locked set for the CURRENT scope (service /
// instance / endpoint); empty unless the operator locked a cohort. Gated
// to the lockable scopes — layer-wide scopes (topology / logs / …) never
// compare. Feeds the per-entity fan-out in `useLayerDashboard`.
const compareScope = computed<CompareScope | null>(() => {
  if (scope.value === 'service' || scope.value === 'instance' || scope.value === 'endpoint') {
    return scope.value;
  }
  return null;
});
const activeSet = computed<string[]>(() => {
  if (compareScope.value === 'service') return lockedServiceIds.value;
  if (compareScope.value === 'instance') return lockedInstanceNames.value;
  if (compareScope.value === 'endpoint') return lockedEndpointNames.value;
  return [];
});
// Canonical key of the CURRENT primary entity, in the SAME representation
// the locked sets use (service id; `compoundKey(serviceId, name)` for
// instance/endpoint). Fed to the fan-out so the primary dedupes out of the
// comparison set instead of being fetched twice. Also drives the cohort
// bar's "primary" chip + the row-list highlight.
const scopePrimaryKey = computed<string | null>(() => {
  if (compareScope.value === 'service') return selectedId.value;
  const svc = selectedId.value ?? '';
  if (compareScope.value === 'instance') {
    return selectedInstance.value ? compoundKey(svc, selectedInstance.value) : null;
  }
  if (compareScope.value === 'endpoint') {
    return selectedEndpoint.value ? compoundKey(svc, selectedEndpoint.value) : null;
  }
  return null;
});

const {
  data,
  isFetching,
  error,
  resultByEntity,
  compareActive,
  compareEntities,
  entityState,
  entityProgress,
} = useLayerDashboard(
  layerKey,
  serviceName,
  scope,
  mockTop,
  { instance: effectiveInstance, endpoint: effectiveEndpoint },
  rangeRef,
  widgetsForQuery,
  configReady,
  activeSet,
  scopePrimaryKey,
);

const compareMode = computed(() => compareActive.value);
// In compare mode the tiles render from the per-entity fan-out, not the
// primary `q` — so widget "no data" fallbacks must consult cohort progress
// (entities arrived/total), not `isFetching` (the primary query only).
// Otherwise a tile shows "no data" while the fan-out is still in flight.
const compareLoading = computed(
  () => compareMode.value && entityProgress.value.arrived < entityProgress.value.total,
);
const widgets = computed(() => config.value?.widgets ?? []);

// Multi-entity compare engine — palette/hue, entity labels, the cohort-bar
// chips/header, and the per-type compare builders (card / line / top-record /
// table). See useCompareEngine.
const {
  compareHue,
  rowHue,
  entityLabel,
  compareTableEntities,
  compareTableRows,
  cohortChips,
  cohortVisible,
  cohortHeader,
  unlockChip,
  clearCohort,
  cardValueFor,
  cardTextFor,
  multiLineSeries,
  lineLen,
  multiTopGroups,
  hasMultiTopData,
} = useCompareEngine({
  compareScope,
  compareEntities,
  scopePrimaryKey,
  selectedId,
  landingRows,
  serviceRoster,
  resultByEntity,
  entityState,
  compareMode,
  compareLoading,
  activeSet,
  widgetsForQuery,
  widgets,
});

// Line-cell drill-out → multi-entity overlay chart.
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
  effectiveInstance,
  endpointList,
  effectiveEndpoint,
  dashboard: data,
});

// Cascade-clear-then-load: track whether the dashboard data on hand
// actually matches the current selection. The moment an upstream
// pick (service / instance / endpoint / scope / range) changes, we
// flip to "stale" and the template's "Reading data…" gate fires
// even if vue-query is still surfacing the previous key's data
// during the fetch (cache hit OR background fetch). When the new
// query resolves, the data ref updates and we mark fresh again.
// This is what makes the page visibly reset on click rather than
// looking frozen on the prior widgets.
const fetchKey = computed(
  () =>
    `${layerKey.value}|${scope.value}|${serviceName.value ?? ''}|${selectedInstance.value ?? ''}|${selectedEndpoint.value ?? ''}|${timeRange.range.startMs}|${timeRange.range.endMs}|${timeRange.step}`,
);
const lastFreshKey = ref<string | null>(null);
// `immediate` marks a warm-cache remount fresh, else the "Reading data…" gate hangs.
watch(
  data,
  (d) => {
    if (d !== null && d !== undefined) lastFreshKey.value = fetchKey.value;
  },
  { immediate: true },
);
const dataIsFresh = computed(() => lastFreshKey.value === fetchKey.value);

const resultsById = computed(() => {
  const out = new Map<string, NonNullable<typeof data.value>['widgets'][number]>();
  // Only surface widget results from a response that matches the
  // current selection — otherwise we'd briefly render prior-key
  // values under the new picker state.
  if (!dataIsFresh.value) return out;
  for (const r of data.value?.widgets ?? []) out.set(r.id, r);
  return out;
});
const reachable = computed(() => {
  const primaryOk = data.value?.reachable !== false;
  if (!compareMode.value || primaryOk) return primaryOk;
  // Compare: a failed primary must not flag "unreachable" over a cohort grid
  // still rendering pinned-entity data (or still arriving).
  return compareLoading.value || compareEntities.value.some((e) => resultByEntity.value.get(e) !== undefined);
});
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
  // Match the metric key (cpm / sla / apdex / err / p50..p99 / …) in
  // id, then title, then first expression — whichever names it first.
  const candidates: string[] = [];
  if (w.id) candidates.push(w.id);
  if (w.title) candidates.push(w.title);
  if (w.expressions?.[0]) candidates.push(w.expressions[0]);
  for (const c of candidates) {
    const c2 = c.toLowerCase();
    if (/(^|[^a-z])cpm([^a-z]|$)/.test(c2) || c2.includes('traffic') || c2.includes('rpm')) return 'var(--sw-accent)';
    if (c2.includes('apdex')) return 'var(--sw-purple)';
    if (c2.includes('sla') || c2.includes('success')) return 'var(--sw-purple)';
    if (/p\d{2,3}/.test(c2) || c2.includes('percentile') || c2.includes('resp_time') || c2.includes('response time') || c2.includes('latency')) return 'var(--sw-warn)';
    if (c2.includes('err') || c2.includes('error') || c2.includes('failure')) return 'var(--sw-err)';
  }
  return colorForMetric(w.id || w.title || w.expressions?.[0] || '');
}

// Native-trace layers only — the Zipkin view can't consume the drill filter.
const router = useRouter();
const layerTracesEnabled = computed<boolean>(() => {
  if (layer.value?.caps?.traces !== true) return false;
  const src = layer.value.traces?.source ?? 'native';
  return src === 'native' || src === 'both';
});
function traceDrillMode(w: DashboardWidget): 'latency' | 'error' | null {
  if (w.type !== 'line' || !layerTracesEnabled.value) return null;
  const m = w.traceDrill?.mode;
  return m === 'latency' || m === 'error' ? m : null;
}
function drillCenterMs(dataIndex: number, len: number): number {
  const { startMs, endMs } = timeRange.range;
  if (len <= 1) return endMs;
  return Math.round(startMs + ((endMs - startMs) * dataIndex) / (len - 1));
}
// MINUTE → ±5min; HOUR/DAY → the clicked hour/day (local calendar bucket, DST-safe).
function drillWindow(dataIndex: number, len: number): { fromMs: number; toMs: number; labelMs: number } {
  const center = drillCenterMs(dataIndex, len);
  if (timeRange.step === 'MINUTE') {
    const half = 5 * 60_000;
    return { fromMs: center - half, toMs: center + half, labelMs: center };
  }
  const from = new Date(center);
  from.setMinutes(0, 0, 0);
  if (timeRange.step === 'DAY') from.setHours(0);
  const to = new Date(from);
  if (timeRange.step === 'DAY') to.setDate(to.getDate() + 1);
  else to.setHours(to.getHours() + 1);
  return { fromMs: from.getTime(), toMs: to.getTime(), labelMs: from.getTime() };
}
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const gridEl = ref<HTMLElement | null>(null);
const drill = ref<{
  widgetId: string;
  point: { x: number; y: number };
  query: Record<string, string>;
  title: string;
  meta: string;
  label: string;
} | null>(null);
function onDrillPoint(
  w: DashboardWidget,
  p: { seriesIndex: number; dataIndex: number; value: number; seriesName: string; x: number; y: number },
): void {
  const mode = traceDrillMode(w);
  if (!mode) return;
  const len = resultsById.value.get(w.id)?.series?.[0]?.data.length ?? 0;
  const win = drillWindow(p.dataIndex, len);
  const ms = Math.max(0, Math.round(p.value));
  const query: Record<string, string> = {
    dMode: mode,
    dFrom: toLocalInput(win.fromMs),
    dTo: toLocalInput(win.toMs),
    dNonce: `${win.fromMs}:${p.dataIndex}:${w.id}`,
  };
  if (mode === 'latency') query.dValue = String(ms);
  if (selectedId.value) query.service = selectedId.value;
  if (scope.value === 'instance' && selectedInstance.value) query.dInstance = selectedInstance.value;
  if (scope.value === 'endpoint' && selectedEndpoint.value) query.dEndpoint = selectedEndpoint.value;
  const band = p.seriesName ? `${p.seriesName} · ` : '';
  drill.value = {
    widgetId: w.id,
    point: { x: p.x, y: p.y },
    query,
    title: w.title,
    meta:
      band +
      t('around {t}', { t: bucketTimeLabel(timeRange.step, win.labelMs) }) +
      (mode === 'latency' ? ` · ≥ ${ms} ms` : ''),
    label: mode === 'latency' ? t('View slow traces') : t('View error traces'),
  };
}
function openDrill(): void {
  const d = drill.value;
  if (!d) return;
  drill.value = null;
  const href = router.resolve({ path: `/layer/${layerKey.value}/trace`, query: d.query }).href;
  window.open(href, '_blank', 'noopener');
}
function closeDrill(): void {
  drill.value = null;
}

// Pop-out wiring for top / record widgets. The TopList renders inside the
// widget body; its pop-out trigger lives in the widget's title bar (so it
// can't overlap the in-widget tab row). We hold a per-widget ref to the
// active TopList instance and call its exposed `openExpanded()`.
type TopListExposed = { openExpanded: () => void };
const topListRefs = new Map<string, TopListExposed>();
function setTopListRef(id: string, el: unknown): void {
  if (el) topListRefs.set(id, el as TopListExposed);
  else topListRefs.delete(id);
}
function popOutTopList(id: string): void {
  topListRefs.get(id)?.openExpanded();
}
function hasTopData(w: { id: string; type: string }): boolean {
  // Compare mode renders from the per-entity fan-out — the primary may be empty.
  if (compareMode.value) return hasMultiTopData(w.id);
  const r = resultsById.value.get(w.id);
  if (!r) return false;
  if (w.type === 'top') return !!(r.topGroups?.length || r.topList?.length);
  if (w.type === 'record') return !!r.records?.length;
  return false;
}

/**
 * `visibleWhen` is evaluated BFF-side PER ENTITY: a gated-out widget comes
 * back flagged `hidden: true` (group/entity misses also skip their MQE
 * there). A widget with no result yet (loading) stays visible until its
 * result lands.
 *
 * In compare mode the gate is the UNION across the whole cohort — the widget
 * shows if ANY compared entity has it. `visibleWhen` keys off per-entity
 * facts (a metric existing, an instance attribute like `language=java`), so
 * judging visibility by the banner alone would drop, say, every JVM widget
 * the moment the banner is a non-JVM (e.g. LUA) service even though Java pins
 * carry rich JVM data. It hides only once EVERY entity has loaded and all
 * flag it hidden; while any entity is still loading it stays visible.
 */
function isHidden(id: string): boolean {
  if (!compareMode.value) {
    return resultsById.value.get(id)?.hidden === true;
  }
  let allLoaded = true;
  for (const e of compareEntities.value) {
    const r = resultByEntity.value.get(e)?.get(id);
    if (!r) {
      allLoaded = false;
      continue;
    }
    if (r.hidden !== true) return false; // at least one entity shows it
  }
  // No entity shows it: hide only when the whole cohort has reported in;
  // otherwise keep it visible while results are still arriving.
  return allLoaded && compareEntities.value.length > 0;
}

// Render context handed to TabWidget so a widget inside a tab renders exactly
// like a top-level one — same color, same compare fan-out, same pop-out. The
// helpers below are the very ones the top-level grid uses; `compare` is null
// unless a cohort is locked. (See tabHostCtx.ts.)
const tabHostCtx = computed<TabHostCtx>(() => ({
  widgetColor,
  setTopListRef,
  popOutTopList,
  hasTopData,
  isHidden,
  compare: compareMode.value
    ? {
        entities: compareEntities.value,
        tableEntities: compareTableEntities.value,
        loading: compareLoading.value,
        hue: compareHue,
        label: entityLabel,
        cardText: cardTextFor,
        cardValue: cardValueFor,
        lineSeries: multiLineSeries,
        lineLen,
        topGroups: multiTopGroups,
        hasTop: hasMultiTopData,
        tableRows: compareTableRows,
      }
    : null,
}));
</script>

<template>
  <div class="dash-tab">
    <header v-if="isFetching || compareLoading || !reachable" class="dash-head">
      <span v-if="isFetching || compareLoading" class="badge fetch">refreshing</span>
      <span v-else-if="!reachable" class="badge err">OAP unreachable</span>
    </header>

    <div v-if="!reachable" class="banner err">
      <strong>OAP unreachable.</strong>
      {{ errorText ?? 'Widgets are showing nothing — check the BFF is up and OAP is reachable.' }}
    </div>

    <!-- Instance / endpoint pickers — the sticky list on the left when
         the respective scope is active. Each owns its fetch / auto-pick
         via the cascade composables; these are the presentational shells. -->
    <LayerInstancePicker
      v-if="scope === 'instance'"
      :slot-label="safeLayer.slots.instances || ''"
      :service-name="serviceName"
      :selected-id="selectedId"
      :instances="instanceList"
      :loading="instancesLoading"
      :selected="selectedInstance"
      :at-cap="instAtCap"
      :is-locked="isInstanceLocked"
      :row-hue="rowHue"
      :badge="instanceBadge"
      @pick="setSelectedInstance"
      @toggle-lock="toggleLockInstance"
    />

    <LayerEndpointPicker
      v-if="scope === 'endpoint'"
      :slot-label="safeLayer.slots.endpoints || ''"
      :service-name="serviceName"
      :selected-id="selectedId"
      :endpoints="endpointList"
      :loading="endpointsLoading"
      :selected="selectedEndpoint"
      :query="endpointQuery"
      :at-cap="epAtCap"
      :is-locked="isEndpointLocked"
      :row-hue="rowHue"
      v-model:search-input="endpointSearchInput"
      v-model:limit="endpointLimit"
      @pick="setSelectedEndpoint"
      @toggle-lock="toggleLockEndpoint"
      @submit="submitEndpointSearch"
      @clear="clearEndpointSearch"
    />

    <!-- Main-zone reset-then-load. ONE "Reading data…" state covers the
         WHOLE upstream wait — the config-template fetch AND the
         service→instance→dashboard chain — and it fires the instant any
         upstream pick changes. The grid therefore visibly RESETS first
         instead of lingering on the prior selection's widgets or
         flashing "loading config" → "no widgets" → "reading" in
         sequence (which read as a slow, jumpy entry). The "no widgets"
         branch below only shows once config has actually loaded and the
         layer genuinely defines none. -->
    <div
      v-if="reachable && !noEntityToChart && (configLoading || (!dataIsFresh && widgets.length > 0 && widgetsForQuery.length > 0))"
      class="empty reading"
    >
      <span class="reading-dot" />
      <span>
        Reading data
        <template v-if="serviceName">
          for <b>{{ serviceName }}</b>
          <template v-if="scope === 'instance' && selectedInstance">
            / <b>{{ selectedInstance }}</b>
          </template>
          <template v-else-if="scope === 'endpoint' && selectedEndpoint">
            / <b>{{ selectedEndpoint }}</b>
          </template>
        </template>
        <span v-if="widgetsForQuery.length > 0" class="reading-progress">
          · loading {{ widgetsForQuery.length }} metric{{ widgetsForQuery.length === 1 ? '' : 's' }}
        </span>
      </span>
    </div>
    <div v-else-if="widgets.length === 0" class="empty">
      No widgets defined for this layer. Add some via Dashboard setup → Layer dashboards.
    </div>
    <template v-else>
    <!-- Unified compare cohort bar — the persistent comparison-set surface
         for all three scopes (service / instance / endpoint). The banner
         entity is the CURRENT member (accent, not removable); pins add to it
         and carry × to unpin. Chips are display-only — none switch the
         banner (that stays with the top selector / list rows). -->
    <div v-if="cohortVisible" class="cohort-bar">
      <span class="cohort-head">{{ cohortHeader }}</span>
      <div class="cohort-chips">
        <div
          v-for="c in cohortChips"
          :key="c.key"
          class="cohort-chip"
          :class="{ primary: c.primary, 'is-error': c.state === 'error', 'is-loading': c.state === 'loading' }"
          :style="c.primary ? { borderColor: c.hue } : {}"
          :title="c.state === 'error'
            ? t('Failed to load')
            : c.primary ? t('Current — drives the header KPIs') : c.label"
        >
          <span class="cohort-dot" :style="{ background: c.hue }" />
          <span class="cohort-name">{{ c.label }}</span>
          <span v-if="c.primary" class="cohort-tag">{{ t('CURRENT') }}</span>
          <button
            v-else
            type="button"
            class="cohort-x"
            :title="t('Remove from comparison')"
            @click="unlockChip(c.key)"
          >×</button>
        </div>
      </div>
      <button
        type="button"
        class="cohort-clear"
        :title="t('Clear all and exit comparison')"
        @click="clearCohort"
      >{{ t('Clear all') }}</button>
    </div>
    <!-- Tile grid keeps its normal layout in compare mode; each widget
         renders all N entities inline (card rows / overlaid lines /
         per-entity tabs). -->
    <div ref="gridEl" class="grid">
      <LayerWidgetTile
        v-for="w in widgets.filter((wi) => !isHidden(wi.id))"
        :key="w.id"
        :widget="w"
        :compare-mode="compareMode"
        :is-fetching="isFetching"
        :compare-loading="compareLoading"
        :compare-entities="compareEntities"
        :results="resultsById"
        :active-tab-index="clampedTabIndex(w)"
        :tab-host="tabHostCtx"
        :grid-style="gridStyle"
        :widget-color="widgetColor"
        :x-labels-for-len="xLabelsForLen"
        :card-text="cardText"
        :has-top-data="hasTopData"
        :pop-out-top-list="popOutTopList"
        :set-top-list-ref="setTopListRef"
        :compare-hue="compareHue"
        :entity-label="entityLabel"
        :card-value-for="cardValueFor"
        :card-text-for="cardTextFor"
        :multi-line-series="multiLineSeries"
        :line-len="lineLen"
        :multi-top-groups="multiTopGroups"
        :has-multi-top-data="hasMultiTopData"
        :compare-table-rows="compareTableRows"
        :compare-table-entities="compareTableEntities"
        :trace-drill-mode="traceDrillMode"
        :on-drill-point="onDrillPoint"
        :drill-open-id="drill?.widgetId ?? null"
        @switch-tab="setActiveTab(w.id, $event)"
      />
    </div>
    </template>

    <FloatingPanel
      :open="!!drill"
      :anchor="gridEl"
      :point="drill?.point ?? null"
      :width="240"
      @close="closeDrill"
    >
      <div v-if="drill" class="drill-pop">
        <div class="drill-meta">
          <span class="drill-title">{{ drill.title }}</span>
          <span class="drill-sub">{{ drill.meta }}</span>
        </div>
        <button type="button" class="drill-link" @click="openDrill">
          {{ drill.label }} <span class="arr" aria-hidden="true">→</span>
        </button>
      </div>
    </FloatingPanel>
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
.empty.reading {
  color: var(--sw-fg-1);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}
.reading-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--sw-accent);
  animation: reading-pulse 1.1s ease-in-out infinite;
}
@keyframes reading-pulse {
  0%, 100% { opacity: 0.25; transform: scale(0.7); }
  50%      { opacity: 1;    transform: scale(1);   }
}
.cohort-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 8px 12px;
  margin-bottom: 10px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 6px;
}
.cohort-head {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
  white-space: nowrap;
}
.cohort-chips {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.cohort-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 8px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 12px;
  color: var(--sw-fg-1);
  font-size: 11px;
  /* Display-only — the chip itself isn't a control (only its × is). */
  cursor: default;
}
.cohort-chip.primary {
  font-weight: 700;
  color: var(--sw-fg-0);
}
.cohort-tag {
  margin-left: 2px;
  padding: 0 5px;
  border-radius: 7px;
  background: var(--sw-accent-soft);
  color: var(--sw-accent);
  font-size: 8.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
/* Isolated per-entity fan-out state: a failed entity is tinted (not
   silently blank); a still-loading one dims until its slot resolves. */
.cohort-chip.is-error {
  border-color: var(--sw-err);
  color: var(--sw-err);
}
.cohort-chip.is-loading {
  opacity: 0.6;
}
.cohort-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
.cohort-name {
  font-family: var(--sw-mono);
  max-width: 200px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cohort-x {
  margin-left: 2px;
  padding: 0 2px;
  border: none;
  background: none;
  color: var(--sw-fg-3);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}
.cohort-x:hover {
  color: var(--sw-err);
}
.cohort-clear {
  margin-left: auto;
  padding: 3px 10px;
  border: 1px solid var(--sw-line-2);
  border-radius: 12px;
  background: transparent;
  color: var(--sw-fg-2);
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  cursor: pointer;
  white-space: nowrap;
}
.cohort-clear:hover {
  border-color: var(--sw-err);
  color: var(--sw-err);
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

@media (max-width: 1100px) {
  .grid {
    grid-template-columns: repeat(12, 1fr);
  }
}

.drill-pop {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
}
.drill-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.drill-title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--sw-fg-0);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.drill-sub {
  font-size: 10.5px;
  color: var(--sw-fg-3);
  font-variant-numeric: tabular-nums;
}
.drill-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  padding: 5px 10px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 5px;
  color: var(--sw-accent);
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
}
.drill-link:hover {
  background: var(--sw-bg-3);
  border-color: var(--sw-accent);
}
.drill-link .arr {
  font-size: 12px;
  line-height: 1;
}
</style>
