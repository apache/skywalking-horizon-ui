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
import WidgetTip from '@/components/primitives/WidgetTip.vue';
import TableWidget from '@/render/widgets/TableWidget.vue';
import { colorForMetric } from '@/utils/metricColor';
import { useLayerDashboard, useLayerDashboardConfig } from '@/render/layer-dashboard/useLayerDashboard';
import { useLayerPageOrchestrator } from '@/render/layer-dashboard/useLayerPageOrchestrator';
import { useLayerEndpoints } from '@/layer/useLayerEndpoints';
import { useLayerInstances } from '@/layer/useLayerInstances';
import { useLayerServices } from '@/layer/useLayerServices';
import { useLayerLanding } from '@/layer/useLayerLanding';
import { useTimeRangeStore, type TimeStep } from '@/controls/timeRange';
import { pushEvent } from '@/controls/eventLog';
import { useLayers } from '@/shell/useLayers';
import { useSelectedEndpoint } from '@/layer/useSelectedEndpoint';
import { useSelectedInstance } from '@/layer/useSelectedInstance';
import { useSelectedService } from '@/layer/useSelectedService';
import { useLayerServiceName } from '@/layer/useLayerServiceName';
import { useSetupStore } from '@/state/setup';
import { fmtMetricAs, type MetricFormat } from '@/utils/formatters';
import { ref, watch, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import { FF_ENTITY_COMPARE } from '@/utils/featureFlags';
import { useEntityPalette } from '@/utils/useEntityPalette';
import { serviceBaseName, isBlankServiceName, BLANK_SERVICE_NAME } from '@/utils/serviceName';
import {
  MAX_LOCKED,
  type CompareScope,
  useLayerSelectionStore,
  compoundKey,
  splitCompound,
} from '@/state/layerSelection';
import Icon from '@/components/icons/Icon.vue';

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
// Direct store handle for exact-key cohort removal (cross-service ×).
const selectionStore = useLayerSelectionStore();
const { layers } = useLayers();
const layer = computed<LayerDef | null>(() => layers.value.find((l) => l.key === layerKey.value) ?? null);

const store = useSetupStore();
const safeLayer = computed<LayerDef>(() => layer.value ?? {
  key: layerKey.value, name: layerKey.value, color: 'var(--sw-fg-2)',
  serviceCount: -1, active: false, level: null, slots: {}, caps: {},
});
// Instance-row badge: the layer's configured `instances.badge` attribute
// (default `language`). Hidden when empty or UNKNOWN. See InstanceListConfig.badge.
function instanceBadge(i: { language?: string | null; attributes: Array<{ name: string; value: string }> }): string | null {
  const key = layer.value?.instances?.badge ?? 'language';
  const raw = key.toLowerCase() === 'language'
    ? (i.language ?? '')
    : (i.attributes.find((a) => a.name.toLowerCase() === key.toLowerCase())?.value ?? '');
  return !raw || raw.trim().toUpperCase() === 'UNKNOWN' ? null : raw;
}
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
function fmtBucket(step: TimeStep, ms: number): string {
  const d = new Date(ms);
  const z = (n: number) => String(n).padStart(2, '0');
  if (step === 'DAY') return `${z(d.getMonth() + 1)}-${z(d.getDate())}`;
  if (step === 'HOUR') return `${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:00`;
  return `${z(d.getHours())}:${z(d.getMinutes())}`;
}
function xLabelsForLen(len: number): string[] {
  if (len <= 0) return [];
  const { startMs, endMs } = timeRange.range;
  const step = timeRange.step;
  if (len === 1) return [fmtBucket(step, endMs)];
  return Array.from({ length: len }, (_, i) =>
    fmtBucket(step, startMs + ((endMs - startMs) * i) / (len - 1)),
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

// Instance selection: only meaningful on the Instance scope, but the
// selector renders whenever a service is picked AND scope === instance.
// Cleared automatically when the service changes so a stale instance
// from a previous service doesn't bleed into the next one's queries.
const { selectedInstance, setSelectedInstance, lockedInstanceNames, toggleLockInstance, isInstanceLocked } =
  useSelectedInstance();
// Instance list waits for `serviceName` (post-landing), not the URL
// id fallback. Enforces the cascade: landing → service → instance →
// metrics, each step firing exactly once after the prior resolves.
const { instances: instanceList, isFetching: instancesLoading } = useLayerInstances(
  layerKey,
  serviceName,
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
// Drop the stale instance whenever the service ACTUALLY changes —
// the new service's instance list almost never matches the previous
// pick. The transition `null → "service-name"` (initial landing
// resolution) is NOT a service change and must not clear the URL
// `?instance=` — doing so blew away the operator's URL pick before
// the auto-pick / fallback path could even read it, and the dashboard
// query then waited for the next instance list + auto-pick cycle.
// Only fire when both ends of the transition are real service names.
watch(serviceName, (next, prev) => {
  if (!prev || !next) return;
  if (next !== prev && selectedInstance.value) {
    setSelectedInstance(null);
  }
});
// Default-select the first instance once the list arrives, but only
// on the Instance scope (so other scopes don't bake an instance into
// their URL on every visit). `immediate: true` so a cache-hit on
// mount (vue-query had this serviceId's instance list already, e.g.
// because the shell init gate stretched the mount past the query's
// first response) still fires the auto-pick — without it, the watch
// would only catch the transition from [] to [...] and silently skip
// the pick when the list arrived synchronously.
watch([instanceList, scope], ([list, s]) => {
  if (s !== 'instance') return;
  // Don't clear the URL ?instance= when the list is TEMPORARILY
  // empty (e.g. service just changed and the instance query is
  // re-firing) — clearing causes a visible URL bounce that
  // strips the operator's pick and breaks dashboard.enabled. We
  // simply wait for actual instance data; if the list eventually
  // resolves to truly empty (instancesLoading false + length 0),
  // the picker's own empty state handles it and the dashboard
  // gate keeps the widget batch quiet.
  if (list.length === 0) return;
  // Quiet default (no URL pick) vs noted fallback (stale URL pick).
  if (!selectedInstance.value) {
    setSelectedInstance(list[0].name);
    return;
  }
  if (!list.some((i) => i.name === selectedInstance.value)) {
    pushEvent(
      'fallback',
      'info',
      `URL instance "${selectedInstance.value}" not in ${serviceName.value} · falling back to "${list[0].name}"`,
    );
    setSelectedInstance(list[0].name);
  }
}, { immediate: true });

// Endpoint selection — same pattern as instance, with a keyword
// search box driving findEndpoint(...). Endpoints are unbounded so
// there's no full-page paging; the picker is top 20…50. Search fires
// on Enter (not on every keystroke) so the operator can type a
// multi-word query without watching the BFF re-query each character.
const { selectedEndpoint, setSelectedEndpoint, lockedEndpointNames, toggleLockEndpoint, isEndpointLocked } =
  useSelectedEndpoint();
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
// Same cascade-strict rule as instance list — endpoint list
// waits for `serviceName` (post-landing), not the URL handle.
const { endpoints: endpointList, isFetching: endpointsLoading } = useLayerEndpoints(
  layerKey,
  serviceName,
  endpointQuery,
  endpointLimit,
);
// URL-pinned endpoint validation. The list above is the recent top-N
// (empty query); a deep-linked endpoint outside it would look "stale".
// This re-queries by the pinned endpoint's own name to confirm it really
// exists for this service before we discard the deep link. Inactive
// (empty query) once the pin is null or already present in the default list.
const pinnedEndpointQuery = computed(() => {
  const pinned = selectedEndpoint.value;
  if (!pinned) return '';
  return endpointList.value.some((e) => e.name === pinned) ? '' : pinned;
});
const { endpoints: pinnedEndpointMatches, isFetching: pinnedEndpointLoading } =
  useLayerEndpoints(layerKey, serviceName, pinnedEndpointQuery, endpointLimit);
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
  if (endpointsLoading.value) return;
  const list = endpointList.value;
  if (list.length === 0) return;
  // Quiet default (no URL pick) vs noted fallback (URL endpoint not
  // in the resolved list — log a debug event so the operator sees
  // the fallback).
  if (!selectedEndpoint.value) {
    setSelectedEndpoint(list[0].name);
    return;
  }
  if (!list.some((e) => e.name === selectedEndpoint.value)) {
    // Outside the default top-N — confirm via the targeted name search
    // before discarding the deep link.
    if (pinnedEndpointQuery.value && pinnedEndpointLoading.value) return; // wait for the lookup
    if (pinnedEndpointMatches.value.some((e) => e.name === selectedEndpoint.value)) return; // valid → keep
    pushEvent(
      'fallback',
      'info',
      `URL endpoint "${selectedEndpoint.value}" not found in ${serviceName.value} · falling back to "${list[0].name}"`,
    );
    setSelectedEndpoint(list[0].name);
  }
});
// Drop stale endpoint when service ACTUALLY changes — same rule as
// the instance counterpart above: the `null → name` landing-resolution
// transition must not clear the URL `?endpoint=`.
watch(serviceName, (next, prev) => {
  if (!prev || !next) return;
  if (next !== prev && selectedEndpoint.value) {
    setSelectedEndpoint(null);
  }
});
// Default-selection of the first endpoint happens inside the
// `watchEffect` above so the service → endpoint sequence is
// deterministic; no separate watch needed here.

// Resolved entity, fed to the widget batch. Only non-null AFTER
// the list has arrived AND the selection is verified to exist in
// it — covers both:
//   - URL pick matches a real list entry  ⇒ use it
//   - URL pick doesn't match              ⇒ stay null while the
//     auto-pick/fallback watch above swaps selectedInstance to
//     list[0], which then flips this computed to the new value
// While the list is loading (length 0) the entity is null too, so
// the dashboard stays gated. No wasted "wrong-id then fixed" round-trip.
const effectiveInstance = computed<string | null>(() => {
  const v = selectedInstance.value;
  if (!v) return null;
  return instanceList.value.some((i) => i.name === v) ? v : null;
});
const effectiveEndpoint = computed<string | null>(() => {
  const v = selectedEndpoint.value;
  if (!v) return null;
  // Valid if in the default top-N OR confirmed by the targeted name lookup
  // (a deep-linked endpoint outside the recent list) — otherwise the
  // dashboard would stay gated forever for a perfectly valid pin.
  if (endpointList.value.some((e) => e.name === v)) return v;
  if (pinnedEndpointMatches.value.some((e) => e.name === v)) return v;
  return null;
});
// Instance / endpoint scopes gate the widget batch on a resolved entity
// (see useLayerDashboard `enabled`). When the entity list settles EMPTY —
// the service genuinely reports no instances / endpoints (or a search
// matched nothing) — no entity can ever be picked, the dashboard query
// never fires, and `dataIsFresh` never flips. Used only to suppress the
// reset-then-load overlay in that terminal state so it doesn't spin
// "Reading data…" forever; the page then falls through to the widget
// grid, which renders every widget in its empty "no data" state (the
// layout still reads — another MQ / service may well have topics).
// `resolvable` stays true while a list / pin lookup is still in flight so
// the overlay still covers the genuine wait.
const endpointResolvable = computed<boolean>(
  () =>
    endpointsLoading.value ||
    pinnedEndpointLoading.value ||
    endpointList.value.length > 0 ||
    !!effectiveEndpoint.value,
);
const instanceResolvable = computed<boolean>(
  () => instancesLoading.value || instanceList.value.length > 0 || !!effectiveInstance.value,
);
const noEntityToChart = computed<boolean>(() => {
  if (!serviceName.value) return false; // service still resolving — keep waiting
  if (scope.value === 'instance') return !instanceResolvable.value;
  if (scope.value === 'endpoint') return !endpointResolvable.value;
  return false;
});
const widgetsForQuery = computed(() => config.value?.widgets ?? []);
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
  if (!FF_ENTITY_COMPARE) return [];
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

const compareMode = computed(() => FF_ENTITY_COMPARE && compareActive.value);
// In compare mode the tiles render from the per-entity fan-out, not the
// primary `q` — so widget "no data" fallbacks must consult cohort progress
// (entities arrived/total), not `isFetching` (the primary query only).
// Otherwise a tile shows "no data" while the fan-out is still in flight.
const compareLoading = computed(
  () => compareMode.value && entityProgress.value.arrived < entityProgress.value.total,
);
const palette = useEntityPalette();
// The banner (primary) entity always renders in the reserved accent; only the
// PINS draw from the 6-hue palette — so the palette never needs a 7th slot and
// the "current" entity stays visually tied to the orange header KPIs.
watch(
  compareEntities,
  (ids) => palette.syncToIds(ids.filter((id) => id !== scopePrimaryKey.value)),
  { immediate: true },
);
function compareHue(key: string): string {
  return key === scopePrimaryKey.value ? 'var(--sw-accent)' : palette.hueFor(key);
}
// Hue for an instance/endpoint ROW (raw name) under the current service —
// the palette is keyed by the cross-service compound key.
function rowHue(name: string): string {
  return compareHue(compoundKey(selectedId.value ?? '', name));
}
// Display label for an entity key, scope-aware: service ids resolve to a
// base name from the roster; instance/endpoint names render as-is.
function serviceLabelFor(id: string): string {
  // landing sample first (has metrics), then the FULL roster so a locked
  // low-traffic service beyond the top-N sample still resolves to a name.
  const name =
    landingRows.value.find((s) => s.serviceId === id)?.serviceName ??
    serviceRoster.value.find((s) => s.id === id)?.name ??
    id;
  return isBlankServiceName(name) ? BLANK_SERVICE_NAME : serviceBaseName(name);
}
function entityLabel(key: string): string {
  if (compareScope.value === 'service') return serviceLabelFor(key);
  // instance/endpoint: cross-service compound key → "<serviceBase> · <name>".
  const { service: svc, name } = splitCompound(key);
  return svc ? `${serviceLabelFor(svc)} · ${name}` : name;
}
function resultFor(widgetId: string, entityKey: string) {
  return resultByEntity.value.get(entityKey)?.get(widgetId);
}
// Table widgets compare per-entity: gather each entity's rows tagged
// with its key (Option B puts no entityKey on the wire) for TableWidget.
const compareTableEntities = computed(() =>
  compareEntities.value.map((e) => ({ key: e, name: entityLabel(e), hue: compareHue(e) })),
);
function compareTableRows(widgetId: string) {
  return compareEntities.value.flatMap((e) =>
    (resultFor(widgetId, e)?.table ?? []).map((r) => ({ ...r, entityKey: e })),
  );
}

// --- Unified compare cohort bar (scope-aware) ---------------------------
// The persistent working-set surface, decoupled from the (service-
// dependent, paginated) selection list. Shows the comparison set = the
// locked set; the list pins are the ADD affordance. All three scopes
// differ in key/label/primary/unlock, handled below. (`scopePrimaryKey`
// is defined above the dashboard call so the fan-out can dedupe with it.)
interface CohortChip {
  key: string;
  label: string;
  hue: string;
  primary: boolean;
  /** Per-entity fetch state — surfaces the isolated fan-out error/loading
   *  on the chip so a failed entity is visible (not silently blank). */
  state: 'loading' | 'ready' | 'error';
}
const cohortChips = computed<CohortChip[]>(() =>
  compareEntities.value.map((key) => ({
    key,
    label: entityLabel(key),
    hue: compareHue(key),
    primary: key === scopePrimaryKey.value,
    state: entityState(key),
  })),
);
// Distinct services represented in the locked instance/endpoint cohort.
// A cross-service cohort (size > 1) can't be summarised as "of {service}".
const cohortServices = computed<string[]>(() => {
  const set = new Set<string>();
  for (const key of compareEntities.value) set.add(splitCompound(key).service);
  return [...set];
});
// Show the cohort bar from the FIRST lock (so a single lock is visible
// regardless of list churn); the grid itself still needs >=2.
const cohortVisible = computed(() => activeSet.value.length >= 1);
const cohortHeader = computed<string>(() => {
  const n = compareEntities.value.length;
  if (n < 2) return t('{n} locked · lock 1 more to compare', { n });
  if (compareScope.value === 'service') return t('Comparing {n} services', { n });
  // instance/endpoint: name the service only when the whole cohort shares
  // one; a mixed-service cohort says "across services" (chips carry the
  // per-entity service prefix).
  const svcs = cohortServices.value;
  const single = svcs.length === 1 ? serviceLabelFor(svcs[0]) : null;
  if (compareScope.value === 'instance') {
    return single
      ? t('Comparing {n} instances of {service}', { n, service: single })
      : t('Comparing {n} instances across services', { n });
  }
  return single
    ? t('Comparing {n} endpoints of {service}', { n, service: single })
    : t('Comparing {n} endpoints across services', { n });
});
// Cohort chips are display-only: a pin is a comparison member, NOT a
// banner control. Clicking a chip must NOT refocus the banner (that would
// re-query the primary + reload the instance/endpoint list — the disruptive
// "refresh" we explicitly avoid). The banner changes only through the top
// selector / list rows; chips offer just the × (unpin), and the CURRENT chip
// (the banner entity) isn't removable.
function unlockChip(key: string): void {
  // Remove the EXACT key (compound for instance/endpoint) — it may
  // belong to a service other than the current primary.
  if (compareScope.value) selectionStore.removeKey(compareScope.value, key);
}

// --- Multi-entity INLINE rendering -------------------------------------
// In compare mode every widget keeps its normal tile and renders all N
// entities inside it: card -> one row per entity, line -> N overlaid
// (entity-hued) lines, top/record -> per-entity tabs + a merged "All".
function cardValueFor(wid: string, e: string): number | null {
  return resultFor(wid, e)?.value ?? null;
}
function cardTextFor(w: { id: string; format?: MetricFormat; valueMap?: Record<string, string> }, e: string): string {
  const v = cardValueFor(w.id, e);
  if (v != null && w.format === 'enum' && w.valueMap) {
    const lbl = w.valueMap[String(Math.round(v))];
    if (lbl != null) return lbl;
  }
  return fmtMetricAs(v, w.format);
}
interface CompareSeries {
  label: string;
  data: Array<number | null>;
  yAxisIndex?: number;
  unit?: string;
  color: string;
}
function multiLineSeries(wid: string): CompareSeries[] {
  const out: CompareSeries[] = [];
  for (const e of compareEntities.value) {
    const series = resultFor(wid, e)?.series ?? [];
    const multi = series.length > 1;
    for (const s of series) {
      out.push({
        // Label FIRST, then the entity (`service · instance/endpoint`): the
        // per-series label (e.g. a JVM thread state) is the valuable tag and
        // must survive truncation, whereas a long instance/endpoint name can
        // ellipsize at the tail. Entities stay distinguishable by hue + the
        // (differing) start of the name.
        label: multi ? `${s.label} · ${entityLabel(e)}` : entityLabel(e),
        data: s.data,
        ...(s.yAxisIndex !== undefined ? { yAxisIndex: s.yAxisIndex } : {}),
        ...(s.unit ? { unit: s.unit } : {}),
        color: compareHue(e),
      });
    }
  }
  return out;
}
function lineLen(wid: string): number {
  for (const e of compareEntities.value) {
    const d = resultFor(wid, e)?.series?.[0]?.data;
    if (d && d.length) return d.length;
  }
  return 0;
}
interface TopItem {
  name: string;
  value: number | null;
}
function topItemsFor(wid: string, e: string): TopItem[] {
  const r = resultFor(wid, e);
  if (!r) return [];
  if (r.topList) return r.topList;
  if (r.topGroups && r.topGroups[0]) return r.topGroups[0].items;
  if (r.records) return r.records.map((x) => ({ name: x.name, value: x.value ?? null }));
  return [];
}
interface TopGroup {
  label: string;
  expression: string;
  items: TopItem[];
}
// "All" follows the response's own asc/desc (MQE-fixed) then prefixes the
// entity; per-entity groups keep each entity's native order.
function multiTopGroups(wid: string): TopGroup[] {
  const ents = compareEntities.value;
  // Detect the MQE's fixed asc/desc from the FIRST entity that actually has
  // >=2 items — probing only ents[0] inverts the merged sort when the primary
  // happens to be sparse while a pinned entity carries the full ranking.
  const probe = ents.map((e) => topItemsFor(wid, e)).find((it) => it.length >= 2) ?? [];
  const desc = probe.length < 2 || (probe[0].value ?? 0) >= (probe[probe.length - 1].value ?? 0);
  const all: TopItem[] = ents.flatMap((e) =>
    topItemsFor(wid, e).map((it) => ({ name: `${entityLabel(e)} · ${it.name}`, value: it.value })),
  );
  all.sort((a, b) => {
    const av = a.value ?? (desc ? -Infinity : Infinity);
    const bv = b.value ?? (desc ? -Infinity : Infinity);
    return desc ? bv - av : av - bv;
  });
  const groups: TopGroup[] = [{ label: t('All'), expression: '', items: all }];
  for (const e of ents) groups.push({ label: entityLabel(e), expression: '', items: topItemsFor(wid, e) });
  return groups;
}
function hasMultiTopData(wid: string): boolean {
  return compareEntities.value.some((e) => topItemsFor(wid, e).length > 0);
}
// Instance/endpoint row lock pins (service-scope locking lives in the
// shell). Shown behind the flag; cap-guarded per scope.
const compareLockable = computed(() => FF_ENTITY_COMPARE);
const instAtCap = computed(() => lockedInstanceNames.value.length >= MAX_LOCKED);
const epAtCap = computed(() => lockedEndpointNames.value.length >= MAX_LOCKED);

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

const widgets = computed(() => config.value?.widgets ?? []);

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
watch(data, (d) => {
  if (d !== null && d !== undefined) {
    lastFreshKey.value = fetchKey.value;
  }
});
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
        <span class="kicker">{{ safeLayer.slots.instances || 'Instance' }}</span>
        <!-- Header strictly tracks the resolved `serviceName` —
             never the raw `?service=` base64 id from the URL.
             While landing is still loading we show a loading hint
             instead, matching the cascade-clear-then-load
             principle (downstream waits for upstream). -->
        <span v-if="serviceName" class="for-svc">
          for <b>{{ serviceName }}</b>
          <span v-if="instanceList.length > 0" class="count">{{ instanceList.length }}</span>
        </span>
        <span v-else-if="selectedId" class="hint">resolving service…</span>
        <span v-if="instancesLoading" class="hint">loading instances…</span>
      </header>
      <div v-if="!selectedId" class="empty inline">
        Pick a service in the picker above to list its instances.
      </div>
      <div v-else-if="!serviceName" class="empty inline">
        Resolving service…
      </div>
      <div v-else-if="!instancesLoading && instanceList.length === 0" class="empty inline">
        No active instances reported for {{ serviceName }} in the last 15 minutes.
      </div>
      <ul v-else class="ib-list">
        <li
          v-for="i in instanceList"
          :key="i.id"
          class="ib-row"
          :class="{ on: selectedInstance === i.name, 'has-lock': compareLockable }"
        >
          <button
            v-if="compareLockable"
            type="button"
            class="ib-lock"
            :class="{ locked: isInstanceLocked(i.name) }"
            :disabled="!isInstanceLocked(i.name) && instAtCap"
            :title="isInstanceLocked(i.name) ? t('Remove from comparison') : t('Add to comparison')"
            @click.stop="toggleLockInstance(i.name)"
          >
            <span v-if="isInstanceLocked(i.name)" class="ib-lock-dot" :style="{ background: rowHue(i.name) }" />
            <Icon v-else name="pin" :size="11" />
          </button>
          <button
            type="button"
            class="ib-pick-btn"
            @click="setSelectedInstance(i.name)"
          >
            <span class="ib-name">{{ i.name }}</span>
            <span v-if="instanceBadge(i)" class="ib-lang">{{ instanceBadge(i) }}</span>
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
        <span class="kicker">{{ safeLayer.slots.endpoints || 'Endpoint' }}</span>
        <!-- Strictly serviceName, no base64-id fallback (same rule
             as the instance picker above). -->
        <span v-if="serviceName" class="for-svc">
          for <b>{{ serviceName }}</b>
          <span v-if="endpointList.length > 0" class="count">{{ endpointList.length }}</span>
        </span>
        <span v-else-if="selectedId" class="hint">resolving service…</span>
        <span v-if="endpointsLoading" class="hint">loading endpoints…</span>
      </header>
      <div v-if="!selectedId" class="empty inline">
        Pick a service in the picker above to search its endpoints.
      </div>
      <div v-else-if="!serviceName" class="empty inline">
        Resolving service…
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
            :class="{ on: selectedEndpoint === e.name, 'has-lock': compareLockable }"
          >
            <button
              v-if="compareLockable"
              type="button"
              class="ib-lock"
              :class="{ locked: isEndpointLocked(e.name) }"
              :disabled="!isEndpointLocked(e.name) && epAtCap"
              :title="isEndpointLocked(e.name) ? t('Remove from comparison') : t('Add to comparison')"
              @click.stop="toggleLockEndpoint(e.name)"
            >
              <span v-if="isEndpointLocked(e.name)" class="ib-lock-dot" :style="{ background: rowHue(e.name) }" />
              <Icon v-else name="pin" :size="11" />
            </button>
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
      v-if="reachable && !noEntityToChart && (configLoading || (!dataIsFresh && widgets.length > 0))"
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
        <span v-if="widgets.length > 0" class="reading-progress">
          · loading {{ widgets.length }} metric{{ widgets.length === 1 ? '' : 's' }}
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
    </div>
    <!-- Tile grid keeps its normal layout in compare mode; each widget
         renders all N entities inline (card rows / overlaid lines /
         per-entity tabs). -->
    <div class="grid">
      <div
        v-for="w in widgets.filter((wi) => !isHidden(wi.id))"
        :key="w.id"
        class="widget sw-card"
        :style="{ ...gridStyle(w), '--widget-accent': widgetColor(w) }"
      >
        <div class="w-head">
          <!-- Title + tip group, kept adjacent so the tip chip sits
               next to the title text rather than floating away when
               the right-side affordances exist. -->
          <div class="w-head-title">
            <h4>{{ w.title }}</h4>
            <WidgetTip :tip="w.tip" />
          </div>
          <div class="w-head-right">
            <!-- Card widgets render the unit beneath the big value;
                 surfacing it here too is a duplicate. Other types
                 (line / top / record) need the unit hint here because
                 their bodies don't reprint it. -->
            <span v-if="w.unit && w.type !== 'card'" class="unit">{{ w.unit }}</span>
            <button
              v-if="(w.type === 'top' || w.type === 'record') && hasTopData(w)"
              type="button"
              class="w-popout"
              title="Pop out — full list"
              aria-label="Pop out full list"
              @click="popOutTopList(w.id)"
            >⤢</button>
          </div>
        </div>
        <div class="w-body" :class="`type-${w.type}`">
          <!-- The primary query's per-widget error gates ONLY the single-
               entity view. In compare mode the grid renders from the
               per-entity fan-out (errors are isolated per entity — a bad
               primary, or a primary outside the locked cohort, must not
               blank valid locked-entity results). -->
          <template v-if="!compareMode && resultsById.get(w.id)?.error">
            <span class="muted">{{ resultsById.get(w.id)!.error }}</span>
          </template>
          <template v-else-if="w.type === 'card'">
            <div v-if="compareMode" class="card-compare">
              <div v-for="e in compareEntities" :key="e" class="cc-row">
                <span class="cc-dot" :style="{ background: compareHue(e) }" />
                <span class="cc-name" :title="entityLabel(e)">{{ entityLabel(e) }}</span>
                <span class="cc-val" :class="{ muted: cardValueFor(w.id, e) == null }">{{ cardTextFor(w, e) }}</span>
              </div>
            </div>
            <div v-else class="card-value">
              <span class="num" :class="{ muted: resultsById.get(w.id)?.value == null }">
                {{ resultsById.has(w.id)
                  ? cardText(w)
                  : (isFetching ? '…' : fmtMetricAs(null, w.format)) }}
              </span>
              <span v-if="w.unit" class="unit">{{ w.unit }}</span>
            </div>
          </template>
          <template v-else-if="w.type === 'line'">
            <TimeChart
              v-if="compareMode ? multiLineSeries(w.id).length : resultsById.get(w.id)?.series?.length"
              :series="compareMode ? multiLineSeries(w.id) : resultsById.get(w.id)!.series!"
              :unit="w.unit"
              :height="(w.rowSpan ?? 1) * 110 - 50"
              :accent="widgetColor(w)"
              :format="w.format"
              :x-labels="xLabelsForLen(compareMode ? lineLen(w.id) : (resultsById.get(w.id)!.series![0]?.data.length ?? 0))"
            />
            <span v-else class="muted">{{ (compareMode ? compareLoading : (isFetching && !resultsById.has(w.id))) ? 'loading…' : 'no data' }}</span>
          </template>
          <template v-else-if="w.type === 'top'">
            <TopList
              v-if="compareMode && hasMultiTopData(w.id)"
              :ref="(el) => setTopListRef(w.id, el)"
              :groups="multiTopGroups(w.id)"
              :unit="w.unit"
              :color="widgetColor(w)"
              :title="w.title"
            />
            <TopList
              v-else-if="!compareMode && resultsById.get(w.id)?.topGroups?.length"
              :ref="(el) => setTopListRef(w.id, el)"
              :groups="resultsById.get(w.id)!.topGroups!"
              :unit="w.unit"
              :color="widgetColor(w)"
              :title="w.title"
            />
            <TopList
              v-else-if="!compareMode && resultsById.get(w.id)?.topList?.length"
              :ref="(el) => setTopListRef(w.id, el)"
              :items="resultsById.get(w.id)!.topList!"
              :unit="w.unit"
              :color="widgetColor(w)"
              :title="w.title"
            />
            <span v-else class="muted">{{ (compareMode ? compareLoading : (isFetching && !resultsById.has(w.id))) ? 'loading…' : 'no data' }}</span>
          </template>
          <template v-else-if="w.type === 'record'">
            <!-- Slow-statement / record table — reuses the TopList
                 renderer since the shape (name + value) is identical.
                 Future runtime work will add trace-id drill-in. -->
            <TopList
              v-if="compareMode && hasMultiTopData(w.id)"
              :ref="(el) => setTopListRef(w.id, el)"
              :groups="multiTopGroups(w.id)"
              :unit="w.unit"
              :color="widgetColor(w)"
              :title="w.title"
            />
            <TopList
              v-else-if="!compareMode && resultsById.get(w.id)?.records?.length"
              :ref="(el) => setTopListRef(w.id, el)"
              :items="resultsById.get(w.id)!.records!.map((r) => ({ name: r.name, value: r.value ?? null }))"
              :unit="w.unit"
              :color="widgetColor(w)"
              :title="w.title"
            />
            <span v-else class="muted">{{ (compareMode ? compareLoading : (isFetching && !resultsById.has(w.id))) ? 'loading…' : 'no data' }}</span>
          </template>
          <template v-else-if="w.type === 'table'">
            <TableWidget
              v-if="compareMode ? compareTableRows(w.id).length : resultsById.get(w.id)?.table?.length"
              :rows="compareMode ? compareTableRows(w.id) : resultsById.get(w.id)!.table!"
              :entities="compareMode ? compareTableEntities : undefined"
              :label-top-n="w.labelTopN"
              :headers="w.tableHeaders"
              :show-values="w.showTableValues !== false"
              :unit="w.unit"
              :format="w.format"
            />
            <span v-else class="muted">{{ (compareMode ? compareLoading : (isFetching && !resultsById.has(w.id))) ? 'loading…' : 'no data' }}</span>
          </template>
        </div>
      </div>
    </div>
    </template>
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
.ib-row.has-lock {
  grid-template-columns: auto 1fr auto;
}
.ib-lock {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  align-self: center;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--sw-fg-3);
  cursor: pointer;
}
.ib-lock:hover:not(:disabled) {
  color: var(--sw-fg-1);
  background: var(--sw-bg-2);
}
.ib-lock:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.ib-lock-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
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
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--sw-line);
  /* Subtle left-edge accent tinted to the widget's primary metric
   * color — ties each card to the matching KPI in the layer header. */
  border-left: 3px solid var(--widget-accent, var(--sw-accent));
}
.w-head-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
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
.w-head-right {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  flex: 0 0 auto;
}
.w-head .unit {
  font-size: 10.5px;
  color: var(--sw-fg-3);
  flex: 0 0 auto;
}
/* Pop-out trigger for top / record widgets — lives in the title bar so it
 * never overlaps the in-widget tab row. */
.w-popout {
  width: 18px;
  height: 18px;
  padding: 0;
  font-size: 12px;
  line-height: 1;
  color: var(--sw-fg-3);
  background: transparent;
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s;
}
.w-popout:hover {
  color: var(--sw-fg-0);
  border-color: var(--sw-line-2);
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
