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
  Shared shell for every per-layer page (`/layer/:layerKey/*`). Renders
  a header card with the layer's identity, KPI strip, and cap-driven
  tabs, then a router-view outlet for the active sub-route.

  Mirrors design/screens/landing-layer.jsx but with:
    - Real KPI data sourced from /api/layer/:key/landing.aggregates
    - Tabs filtered by the layer's caps (no Logs row when caps.logs=false)
    - No "Overview" tab — per the project directive that Services is the
      default entry; the cross-layer Overview lives at `/`.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useQuery } from '@tanstack/vue-query';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import type { LayerDef, LandingServiceRow } from '@skywalking-horizon-ui/api-client';
import { bffClient } from '@/api/client';
import { useAuthStore } from '@/state/auth';
import { useEventsPopout } from '@/features/events/useEventsPopout';
import Icon from '@/components/icons/Icon.vue';
import Sparkline from '@/components/charts/Sparkline.vue';
import LayerServiceSelector from './LayerServiceSelector.vue';
import { metricMeta } from '@/utils/metricCatalog';
import { colorForMetric } from '@/utils/metricColor';
import { useLayerLanding } from '@/layer/useLayerLanding';
import { useTimeRangeStore } from '@/controls/timeRange';
import { isBuiltInLayerRow, FALLBACK_LAYER_ROW } from '@skywalking-horizon-ui/api-client';
import { useLayers, firstLayerTab, layerMenuRows } from '@/shell/useLayers';
import { layerContentToDef, type LayerTemplateContent } from '@/shell/layerFromTemplate';
import { useSelectedService } from '@/layer/useSelectedService';
import { useLayerServices } from '@/layer/useLayerServices';
import { useLayerSelectionStore } from '@/state/layerSelection';
import { useSetupStore } from '@/state/setup';
import { useConfigBundle } from '@/controls/configBundle';
import { layerMissingReason, type LayerMissingReason } from './layerMissingReason';
import { fmtMetric } from '@/utils/formatters';
import { parseServiceName, isBlankServiceName, BLANK_SERVICE_NAME } from '@/utils/serviceName';

const { t } = useI18n({ useScope: 'global' });

const route = useRoute();
const router = useRouter();
const layerKey = computed(() => String(route.params.layerKey ?? ''));

// Seed the selection store from the URL ONCE per (layer, scope)
// entry. After this point the store owns the live picker state and
// the URL stays frozen — see state/layerSelection.ts for the
// contract. We rehydrate when the layer or scope segment of the
// route changes so deep-linking still works for cross-layer
// navigation. The scope segment is extracted from `/layer/<key>/<scope>`
// without depending on the nested route's `meta` since that resolves
// later than this watch needs.
const selectionStore = useLayerSelectionStore();
const scopeSegment = computed<string>(() => {
  const m = route.path.match(/^\/layer\/[^/]+\/([^/?]+)/);
  return m ? m[1] : 'service';
});
// Reset the picker state on LAYER change only. Scope/tab navigation
// within the same layer keeps the operator's pick sticky — they
// browse every tab against the service they chose. On a real layer
// change `resetForLayer` reads `?service=` / `?instance=` / `?endpoint=`
// from the new URL so shared / bookmarked deep links land on the
// right service. `flush: 'sync'` makes the reset land before any
// downstream watch can read the previous layer's id.
//
// On unmount (operator leaves the layer to a non-layer page like
// /alarms) we also `clear()` the store so the next visit to the
// same layer re-hydrates from URL instead of resuming the prior
// selection. Browsing tabs within a layer keeps LayerShell mounted,
// so this only fires on real exits.
onBeforeUnmount(() => {
  selectionStore.clear();
});
// Re-seed the selection store on layer ENTRY and on any SAME-LAYER
// navigation that arrives with fresh ?service/?instance/?endpoint (deep
// links into the layer the operator is already on). Keyed on the layer
// key plus the three seed params — but the strip below removes those
// params right after seeding, and that removal (params → absent) must NOT
// re-seed, so we only act when the layer changed OR seed params are
// actually present.
watch(
  [layerKey, () => route.query.service, () => route.query.instance, () => route.query.endpoint],
  ([key], prev) => {
    if (!key) return;
    const q = route.query;
    const hasSeed = q.service != null || q.instance != null || q.endpoint != null;
    const layerChanged = key !== (prev?.[0] as string | undefined);
    if (!layerChanged && !hasSeed) return;
    selectionStore.resetForLayer(key, q);
    // After hydrating, strip the seed params so the address bar reads as a
    // clean `/layer/<key>/<scope>` URL. The store now owns the live
    // selection; the params were a one-shot seed.
    if (hasSeed) {
      const { service: _s, instance: _i, endpoint: _e, ...rest } = q;
      void _s; void _i; void _e;
      void router.replace({ path: route.path, query: rest });
    }
  },
  { immediate: true, flush: 'sync' },
);
const { layers, isLoading: layersLoading } = useLayers();
// Case-insensitive: URL layer keys are lowercase, registry keys UPPER_SNAKE.
// In preview mode `useLayers` overlays/injects the previewed layer here, so
// this already reflects the draft's components (tab visibility).
const menuLayer = computed<LayerDef | null>(
  () => layers.value.find((l) => l.key.toUpperCase() === layerKey.value.toUpperCase()) ?? null,
);

// Preview mode (`?mode=preview`) — render a configured-but-inactive
// layer (OAP reports no services, so it's absent from the live menu)
// instead of the "Layer not found" gate. Admin-only: the fallback is
// synthesized from the layer template (admin data), so operators /
// viewers still hit the normal gate. Empty metrics are expected — there
// are no services to query.
const auth = useAuthStore();
const eventsPopout = useEventsPopout();
const isAdmin = computed<boolean>(() => !!auth.user?.roles?.includes('admin'));
// Single canonical form: `?mode=preview`. The admin "Open live page"
// link generates exactly this.
const previewAllowed = computed<boolean>(() => route.query.mode === 'preview' && isAdmin.value);
const wantPreviewFallback = computed<boolean>(
  () => previewAllowed.value && !menuLayer.value && !!layerKey.value,
);
const tplQuery = useQuery({
  queryKey: ['layer-preview-templates'],
  queryFn: () => bffClient.layerTemplates.list(),
  enabled: wantPreviewFallback,
  staleTime: 60_000,
});
const previewLoading = computed<boolean>(() => wantPreviewFallback.value && tplQuery.isLoading.value);
const previewLayer = computed<LayerDef | null>(() => {
  if (!wantPreviewFallback.value) return null;
  const t = tplQuery.data.value?.templates.find((x) => x.key.toUpperCase() === layerKey.value.toUpperCase());
  return t ? layerContentToDef(t as unknown as LayerTemplateContent) : null;
});
const layer = computed<LayerDef | null>(() => menuLayer.value ?? previewLayer.value);

// Distinguishes "still loading" from "truly absent" so the "Layer
// not found" card doesn't flash during a login → layer-URL redirect
// (the menu fetch is in-flight and `layers.value` is briefly []).
// We treat the layer as missing only after the menu request has
// settled AND — in preview mode — the template fetch has settled too.
const menuStillLoading = computed<boolean>(
  () => !menuLayer.value && (layersLoading.value || layers.value.length === 0),
);
const layerMissing = computed<boolean>(() => {
  if (layer.value) return false;
  if (menuStillLoading.value) return false;
  if (previewLoading.value) return false;
  return true;
});
// A duplicated layer template is hidden from the menu, so a bookmarked tab
// lands in the gate above — it must not read as "inactive or unknown". The
// conflict list rides on the config bundle, which is pulled once per page
// load: a tab that was ALREADY open when the duplicate appeared shows the
// plain not-found card until it reloads.
const { bundle } = useConfigBundle();
const missingReason = computed<LayerMissingReason>(() =>
  layerMissingReason(bundle.value?.syncStatus.conflicts, layerKey.value),
);
// The duplicate is resolved on the template admin page; link there only for
// operators who may open it (the route itself requires `dashboard:read`).
const canOpenLayerTemplates = computed<boolean>(() => auth.hasVerb('dashboard:read'));

// Auto-redirect when the URL targets a sub-route the layer doesn't
// support — e.g. `/layer/mesh_dp/service` on a layer with
// `components.service: false`. Without this the operator lands on an
// empty "No widgets defined" page even though the layer DOES have
// other tabs (Instance / Logs / …). Fires once per change so the
// browser-back button works as expected.
//
// The layer's resolved rows decide what is reachable — the same list the
// sidebar renders — so a tab the sidebar offers can never bounce the
// operator off it, and a tab it hides can never be sat on.
//
// A bare `/layer/:key` resolves here rather than in the router because the
// answer is per-layer: the router has no menu data, so a static redirect
// could only ever guess `service` and let this watcher correct it on the
// next tick. Waiting for the layer costs the same paint and lands once.
watch(
  [() => route.path, layer, layerMissing],
  ([path, L, missing]) => {
    const bare = /^\/layer\/[^/]+\/?$/.test(path);
    if (bare) {
      if (L) void router.replace({ path: `/layer/${L.key}/${firstLayerTab(L)}`, query: route.query });
      // Unknown layer, menu settled: still leave a real route behind so the
      // shell can render its not-found card against a concrete sub-page.
      else if (missing) void router.replace({ path: `/layer/${layerKey.value}/${FALLBACK_LAYER_ROW}`, query: route.query });
      return;
    }
    if (!L) return;
    const m = path.match(/^\/layer\/[^/]+\/([^/?]+)/);
    if (!m) return;
    const scope = m[1];
    if (layerMenuRows(L).some((r) => r.path === scope)) return; // layer exposes it
    if (!isBuiltInLayerRow(scope)) return; // not a layer sub-page — let the router resolve
    // `zipkin-trace` is reachable WITHOUT being a row. The row exists only
    // when a layer carries both formats and needs two tabs; a pure-zipkin
    // layer shows one Traces row that embeds the same explorer, and the
    // standalone URL still opens it in full. The predicate this watcher
    // replaced had no entry for the path and so never bounced it — routing
    // it by row alone redirected the URL onto the embedded view, which
    // renders without its own toolbar.
    if (scope === 'zipkin-trace' && L.caps?.traces) return;
    const fallback = firstLayerTab(L);
    if (fallback === scope) return; // already at the best fallback
    void router.replace({ path: `/layer/${L.key}/${fallback}`, query: route.query });
  },
  { immediate: true },
);
/**
 * The service list this page is about, as the page's author defined it.
 *
 * It is CONFIGURATION, not a control: derived from the route and the
 * menu, never held as editable state. The operator is not told a filter
 * exists — the page has a name that carries the meaning, and the pattern
 * is template syntax they did not write. Their own search box inside the
 * picker is a separate thing and filters within this set.
 *
 * Being derived is also what removed three bugs the editable version had:
 * a filter that outlived its page, one that survived into another layer,
 * and one an operator could widen past what the page's author intended.
 */
/** The route's entity scope and page id, once, for the page-scoped
 *  lookups below. */
const routePage = computed(() => {
  const m = route.path.match(/^\/layer\/([^/]+)\/([^/?]+)(?:\/([^/?]+))?/);
  const scope = m?.[2] ?? '';
  const ok = scope === 'service' || scope === 'instance' || scope === 'endpoint';
  return { scope: (ok ? scope : '') as '' | 'service' | 'instance' | 'endpoint', pageId: m?.[3] };
});
/** The extension page being rendered, when the route names one. */
const activePageRef = computed(() => {
  const { scope, pageId } = routePage.value;
  if (!scope || !pageId) return null;
  return layer.value?.extPages?.[scope]?.find((p) => p.id === pageId) ?? null;
});
const pageScopeFilter = computed<string>(() => {
  const m = route.path.match(/^\/layer\/([^/]+)\/([^/?]+)(?:\/([^/?]+))?/);
  const scope = m?.[2] ?? '';
  const pageId = m?.[3];
  // Any entity page may narrow the service picker: an Instance or
  // Endpoint page shows it too, because you pick a service before the
  // entity the page is about.
  if (scope !== 'service' && scope !== 'instance' && scope !== 'endpoint') return '';
  const entity = scope as 'service' | 'instance' | 'endpoint';
  // No page id is the component's DEFAULT page, which narrows too — it is
  // the page every component already has, not an unfiltered one.
  if (!pageId) return layer.value?.defaultFilters?.[entity]?.serviceFilter ?? '';
  const pages = layer.value?.extPages?.[entity];
  return pages?.find((p) => p.id === pageId)?.serviceFilter ?? '';
});

const store = useSetupStore();
const cfg = computed(() => {
  if (!layer.value) return null;
  return store.ensure(layer.value.key, { slots: layer.value.slots, caps: layer.value.caps, metrics: layer.value.metrics });
});

// Build a non-null LayerDef ref for the landing composable.
const safeLayer = computed<LayerDef>(() => layer.value ?? {
  key: layerKey.value,
  name: layerKey.value,
  color: 'var(--sw-fg-2)',
  serviceCount: -1,
  active: false,
  level: null,
  slots: {},
  caps: {},
});
const safeCfg = computed(() => cfg.value?.landing ?? {
  priority: 99,
  topN: 5,
  orderBy: 'cpm',
  columns: [],
});
// Header KPIs honor the topbar time picker so they line up with what
// the dashboard widgets below are showing — without this, the header
// always queried the BFF's last-60min fallback while the body honored
// the picker, leaving the operator with two contradicting summaries
// (see "Cascade-clear, then load" in CLAUDE.md). On per-tab opt-out
// pages (traces, profiling) the picker is greyed but still carries its
// last value; the header summarizes the layer for that value.
const timeRange = useTimeRangeStore();
const headerRange = computed(() => ({
  step: timeRange.step,
  startMs: timeRange.range.startMs,
  endMs: timeRange.range.endMs,
}));
// `true` — the header is the one screen that prints which hour these numbers
// describe, so it is the one caller allowed to ask for the hourly figures.
const landing = useLayerLanding(safeLayer, safeCfg, headerRange, undefined, true);
/**
 * The header's KPIs describe a completed HOUR, not the picked range.
 *
 * They are read once per layer per hour because the fan-out behind them grows
 * with the layer's service count. Marked with a star and labelled with the
 * hour itself — a relative age would read "an hour ago" and then "two hours
 * ago" at the roll, which looks like a fault rather than a schedule.
 */
const kpiHour = computed(() => landing.data.value?.kpiHour ?? null);
/** The displayed hour is NOT the newest one — a newer bucket is still being
 *  read, so these numbers are roughly two hours old rather than one. The star
 *  marks that exception; the note describes the ordinary case. */
const kpiStale = computed<boolean>(() => kpiHour.value?.stale === true);
/** No completed hour holds anything yet — a new install — so these are the
 *  hour still being written. Read live, and labelled as in progress rather
 *  than as a finished hour it is not. */
const kpiPartial = computed<boolean>(() => kpiHour.value?.partial === true);
// Part of the metric fan-out did not come back. Said here rather than left to
// the blank cells, which read as "idle" — the one reading that is certainly
// wrong, because a service we could not measure is not a service doing nothing.
const landingPartial = computed(() => landing.data.value?.metricsPartial ?? null);
// The hour is being read and there is nothing held yet. Said plainly, because
// the alternative on screen is a strip of dashes, which reads as "no traffic".
const kpiWarming = computed<boolean>(() => landing.data.value?.kpiWarming === true);
const kpiHourLabel = computed<string | null>(() => {
  const h = kpiHour.value;
  if (!h) return null;
  const from = new Date(h.hourStartMs);
  const to = new Date(h.hourStartMs + 3_600_000);
  const hhmm = (d: Date) =>
    `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${hhmm(from)}–${hhmm(to)}`;
});

// Cascade-clear for the header: the instant the layer changes (menu
// click), reset to "no data" so the KPI strip + selected-service values
// blank out (labels stay) instead of lingering on the previous layer's
// numbers. Marked fresh again only once landing data for the new layer
// lands. Cached layers resolve in the same tick, so there's no visible
// flash for them — only a genuine fetch shows the cleared header.
const landingFresh = ref(false);
watch(layerKey, () => { landingFresh.value = false; });
watch(
  () => landing.data.value,
  (d) => { if (d != null) landingFresh.value = true; },
  { immediate: true },
);
const aggregates = computed(() =>
  landingFresh.value ? (landing.data.value?.aggregates ?? null) : null,
);

// Page-wide selected service — in-memory, shared with every tab body
// within the layer. Reset to null on cross-layer navigation via the
// `resetForLayer` watch above; the dashboard view's auto-pick watch
// (further down) sets the first roster entry when the selection is
// null or no longer in the roster.
const { selectedId, setSelected, lockedServiceIds, toggleLockService } = useSelectedService();
const sampledServices = computed(() => landing.data.value?.sampledRows ?? landing.rows.value ?? []);
const selectorColumns = computed(() => safeCfg.value.columns);
// Full service roster (the layer's REAL catalog, independent of landing's
// top-N sample which misses low-traffic services / anything beyond the
// landingServiceCap). A URL `?service=` is validated against THIS, not the
// sample, and `selectedRow` resolves an off-sample selection from it.
const { services: fullRoster, isLoading: rosterLoading } = useLayerServices(layerKey);
const selectedRow = computed<LandingServiceRow | null>(() => {
  const id = selectedId.value;
  if (id) {
    // The sampled row carries metrics — prefer it.
    const inSample = sampledServices.value.find((s) => s.serviceId === id);
    if (inSample) return inSample;
    // Valid but off-sample (low-traffic, or beyond landingServiceCap):
    // resolve the NAME from the full roster so the header + KPI strip
    // reflect the ACTUAL selected service the dashboard queries — not the
    // top sampled one. Metrics aren't in the sample, so the KPIs show
    // dashes (honest "not probed") rather than another service's numbers.
    const inRoster = fullRoster.value.find((s) => s.id === id);
    if (inRoster) {
      return { serviceId: inRoster.id, serviceName: inRoster.name, metrics: {} };
    }
  }
  // No (or genuinely stale) selection → default to the first sampled row.
  return sampledServices.value[0] ?? null;
});
const selectedParsed = computed(() => parseServiceName(selectedRow.value?.serviceName));
const selectedGroup = computed(() => selectedParsed.value.group);
// Switch-button label — base name only when the service has a group
// prefix (`<group>::<base>` from OAP). The group is rendered as a
// separate chip next to the caret so the user reads it without the
// raw `::` syntax bleeding into the UI.
const selectedName = computed(() => {
  if (selectedRow.value) {
    // OAP's blank-entity service has an empty name — show its `_blank` label.
    return isBlankServiceName(selectedRow.value.serviceName) ? BLANK_SERVICE_NAME : selectedParsed.value.base;
  }
  return sampledServices.value.length > 0 ? t('pick a service') : '—';
});

// Routes can declare `meta: { ownsServiceSelector: true }` to opt out
// of the shell-level service picker. Topology is the canonical example
// (its in-box focus selector is the right place to scope the map);
// future component-driven views (dashboards with their own filters,
// say) can flip the same meta flag without touching this file.
const viewOwnsServiceSelector = computed(() => Boolean(route.meta?.ownsServiceSelector));

// --- Multi-entity compare (service scope) -----------------------------
// The picker's lock pins + the header chip bar show only on the SERVICE
// dashboard route — the shell owns service selection; instance/endpoint
// locking lives in the dashboard view's row list.
// Service-scope lock is enabled here (the picker rows own the pins); the
// locked cohort is DISPLAYED by the unified compare bar in the dashboard
// view, so the shell only gates the picker pins, not a chip bar.
const comparable = computed(
  () => !viewOwnsServiceSelector.value && scopeSegment.value === 'service',
);

// Zipkin trace mode is a self-contained, cross-service explorer (its
// own service/duration/annotation filters), so the layer identity +
// service KPI header adds nothing and crowds it out — hide the shell
// header there. Mirrors LayerTracesEntry's zipkin decision: the
// `/zipkin-trace` route always, plus the `/trace` route on a pure-
// zipkin-source layer (mesh / k8s).
const isZipkinTrace = computed<boolean>(() => {
  if (/\/zipkin-trace(\/|$|\?)/.test(route.path)) return true;
  return scopeSegment.value === 'trace' && layer.value?.traces?.source === 'zipkin';
});

// Keep the URL-backed service selection honest for every page that
// uses the shell picker. A `?service=` outside the landing sample is
// trusted when it exists in the full roster; only a genuinely stale id
// (absent from the roster) auto-corrects to the first sampled row, and
// only once the roster has loaded so a valid pin isn't clobbered in flight.
watch(
  [sampledServices, selectedId, viewOwnsServiceSelector, fullRoster, rosterLoading, kpiWarming],
  ([rows, id, ownsSelector, roster, rosterIsLoading, warming]) => {
    if (ownsSelector) return;
    const first = rows[0];
    if (!first) return;
    if (!id) {
      // Not while the hour is still being read. The rows are in roster order
      // then — nothing has been ranked — so the first one is arbitrary, and
      // writing it PINS it: once an id exists this watcher keeps it, and the
      // ranking that arrives a moment later never gets to choose. Waiting
      // costs a second of no selection; not waiting costs the operator the
      // wrong service until they notice and change it.
      if (warming) return;
      setSelected(first.serviceId);
      return;
    }
    if (rows.some((s) => s.serviceId === id)) return; // in the sample → keep
    if (rosterIsLoading) return; // don't clobber a pin while the roster loads
    if (roster.some((s) => s.id === id)) return; // valid in the full roster → keep
    setSelected(first.serviceId); // genuinely stale → fall back
  },
  { immediate: true },
);

// Picker toggle state. Lives at the shell level so the header's Switch
// button and the picker section render against the same state.
const pickerOpen = ref(false);
function togglePicker(): void {
  pickerOpen.value = !pickerOpen.value;
}
function pickService(id: string): void {
  // Update selection FIRST and let the picker render the highlight
  // on the just-clicked row before unmounting — closing in the same
  // tick swallows the visual confirmation that the click registered.
  // 140ms is short enough to feel responsive and long enough for one
  // animation frame to paint the new `:class="{ active }"` state.
  setSelected(id);
  setTimeout(() => {
    pickerOpen.value = false;
  }, 140);
}

// Share button — copies the bare layer URL. Per-page selection state
// is in-memory only and intentionally not encoded in the URL (each
// operator picks their own service on landing; cross-link carryover
// fires the "service not found in this layer" modal on layers where
// the id is invalid). The `copied` chip is the only feedback channel;
// we have no toast system and don't want one for a single action.
const shareCopied = ref(false);
let shareCopiedTimer: ReturnType<typeof setTimeout> | null = null;
async function copyShareLink(): Promise<void> {
  const url = window.location.origin + window.location.pathname;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    // Fallback for non-secure contexts (clipboard API requires HTTPS
    // or localhost). A hidden textarea + execCommand is the only
    // path that works in plain HTTP intranets — common deployment
    // shape for self-hosted OAP installs.
    const ta = document.createElement('textarea');
    ta.value = url;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
  }
  shareCopied.value = true;
  if (shareCopiedTimer) clearTimeout(shareCopiedTimer);
  shareCopiedTimer = setTimeout(() => { shareCopied.value = false; }, 1400);
}

function initialsFor(name: string): string {
  return name
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('') || '?';
}
const displayName = computed(() => cfg.value?.displayName || layer.value?.name || layerKey.value);
const initials = computed(() => initialsFor(displayName.value));
/** The layer's own noun, unaffected by which page is open. */
const layerServiceNoun = computed(() => layer.value?.slots.services || t('services'));
const serviceSlotLabel = computed(
  () =>
    (routePage.value.scope === 'service' ? activePageRef.value?.alias : '') ||
    layer.value?.slots.services ||
    t('services'),
);

// Header KPI strip: at most 5 metrics from the layer's setup columns;
// service count always leads. Each KPI is read from
// /api/layer/:key/landing.aggregates, so it's the same value the
// Overview tile shows.
interface HeaderKpi {
  label: string;
  value: number | null;
  unit?: string;
  /** CSS color for the value text — per-metric color band so the
   *  header reads at a glance (cpm orange, p99 yellow, sla purple,
   *  err red — matches the design's landing-layer KPI row). */
  color: string;
  /** Trend series — rendered as a small inline sparkline under the
   *  value when present. */
  spark?: Array<number | null>;
}
/**
 * Layer-wide aggregate KPIs — sum or avg across the topN services per
 * the column's `aggregation` field in the JSON template. Rendered
 * top-right of the General header. Sparkline = the aggregated series
 * for the same metric.
 */
const layerKpis = computed<HeaderKpi[]>(() => {
  const L = layer.value;
  if (!L) return [];
  const c = cfg.value;
  if (!c) return [];
  const a = aggregates.value;
  const out: HeaderKpi[] = [];
  const headerCols = c.landing.columns;
  for (const col of headerCols.slice(0, 5)) {
    const m = metricMeta(col.metric);
    out.push({
      // Catalog label wins when the persisted `col.label` is a
       // stale no-op (raw metric key, lowercase or empty). Operators
       // who set a custom label still get it shown.
      label: col.label && col.label !== col.metric ? col.label : m.label,
      value: a?.metrics?.[col.metric] ?? null,
      unit: col.unit || m.unit,
      color: colorForMetric(col.metric),
      spark: a?.seriesByMetric?.[col.metric],
    });
  }
  return out;
});

/**
 * Selected-service KPIs — the per-row values for the currently picked
 * service. Rendered on the Switch row beneath the layer aggregates.
 * No sparkline here (the per-service spark series is the service-scope
 * dashboard's job).
 */
const serviceKpis = computed<HeaderKpi[]>(() => {
  const L = layer.value;
  if (!L) return [];
  const c = cfg.value;
  if (!c) return [];
  const row = selectedRow.value;
  if (!row) return [];
  const out: HeaderKpi[] = [];
  const headerCols = c.landing.columns;
  for (const col of headerCols.slice(0, 5)) {
    const m = metricMeta(col.metric);
    out.push({
      // Catalog label wins when the persisted `col.label` is a
       // stale no-op (raw metric key, lowercase or empty). Operators
       // who set a custom label still get it shown.
      label: col.label && col.label !== col.metric ? col.label : m.label,
      value: landingFresh.value ? (row.metrics[col.metric] ?? null) : null,
      unit: col.unit || m.unit,
      color: colorForMetric(col.metric),
    });
  }
  return out;
});

</script>

<template>
  <div class="layer-shell">
    <header v-if="layer && !isZipkinTrace" class="sw-card layer-head">
      <!-- Row 1: layer identity (left) + LAYER aggregate KPI strip
           (right). The aggregates use sum/avg per the JSON columns'
           aggregation field — sum cpm across services, avg p99 etc. -->
      <div class="layer-id-row">
        <div class="icon-tile" :style="{ background: layer.color }">{{ initials }}</div>
        <div class="identity-text">
          <div class="title-row">
            <h1>{{ displayName }}</h1>
            <span v-if="layer.serviceCount === 0" class="sw-badge warn">{{ t('no services') }}</span>
            <span v-else-if="!layer.active" class="sw-badge">{{ t('no data') }}</span>
          </div>
          <div class="sub">
            <!-- The LAYER's noun, never the page's: this count is layer-wide
                 and a page alias here reads as "128 agents" beside a picker
                 showing 4. -->
            {{ layer.serviceCount >= 0 ? `${layer.serviceCount} ${layerServiceNoun.toLowerCase()}` : t('no service data') }}
            <span v-if="layer.documentLink">·
              <a :href="layer.documentLink" target="_blank" rel="noopener noreferrer">{{ t('docs ↗') }}</a>
            </span>
          </div>
        </div>
        <!-- The range is said ONCE for the strip: every KPI here comes from
             the same completed hour. The star appears only when that hour is
             NOT the newest one — an exception worth marking, rather than a
             decoration on every value. -->
        <div v-if="kpiWarming && layerKpis.length > 0" class="kpi-hour-note">
          {{ t('Reading the last completed hour…') }}
        </div>
        <div v-else-if="kpiHourLabel && layerKpis.length > 0" class="kpi-hour-note">
          <template v-if="kpiPartial">{{ t('metrics for the hour so far') }}</template>
          <template v-else-if="kpiStale">
            <span class="kpi-hour-mark">*</span>
            {{ t('metrics for {range} — a newer hour is still loading', { range: kpiHourLabel }) }}
          </template>
          <template v-else>{{ t('metrics for {range}', { range: kpiHourLabel }) }}</template>
        </div>
        <div v-if="landingPartial" class="banner warn kpi-partial">
          {{ t('Some metrics could not be loaded ({failed} of {total} batches failed) — blank values may be unavailable, not zero.', { failed: landingPartial.failedChunks, total: landingPartial.totalChunks }) }}
        </div>
        <div v-if="layerKpis.length > 0" class="kpi-strip layer-kpis">
          <div v-for="(k, i) in layerKpis" :key="i" class="kpi">
            <div class="kpi-label">
              {{ k.label }}<span v-if="k.unit" class="unit">({{ k.unit }})</span>
            </div>
            <div class="kpi-value" :style="{ color: k.color }">
              <span :class="{ muted: k.value == null }">{{ fmtMetric(k.value) }}</span><span
                v-if="kpiStale && k.value != null"
                class="kpi-hour-mark"
              >*</span>
            </div>
            <Sparkline
              v-if="k.spark && k.spark.length > 1"
              class="kpi-spark"
              :values="k.spark"
              :width="84"
              :height="18"
              :color="k.color"
              :stroke="1.25"
            />
            <span v-else class="kpi-spark-empty">&nbsp;</span>
          </div>
        </div>
      </div>

      <!-- Row 2: Switch button + selected-service KPIs. Distinct from
           the layer aggregates above — these are the picked service's
           per-row metric values (no sparklines; the service-scope
           dashboard below carries the trend charts).

           Hidden on the Topology route: the service map is layer-wide
           by design (all services in the layer), and its in-box focus
           selector is the right place to scope to a specific service
           from inside that view. -->
      <div v-if="sampledServices.length > 0 && !viewOwnsServiceSelector" class="service-row">
        <button
          class="sw-btn switch"
          type="button"
          :class="{ open: pickerOpen }"
          @click="togglePicker"
        >
          <span class="caret">▾</span>
          <span v-if="selectedGroup" class="svc-group">{{ selectedGroup }}</span>
          <span class="svc-name">{{ selectedName }}</span>
        </button>
        <!-- Manual refresh — the service list is fetched once per
             (layer, cfg, range) and stays cached afterwards, so the
             operator needs an explicit affordance to pull a fresh
             list. Spins while the refetch is in flight. -->
        <button
          class="sw-btn ghost svc-refresh"
          type="button"
          :title="landing.isFetching.value ? t('Refreshing service list…') : t('Refresh service list')"
          :disabled="landing.isFetching.value"
          @click="() => landing.refetch()"
        >
          <Icon name="refresh" :class="{ spin: landing.isFetching.value }" />
        </button>
        <!-- Share — assemble the current selection into a URL the
             operator can paste anywhere. The URL only carries the
             header selection (service/instance/endpoint); the store
             owns the live state, so this is purely an export. The
             little 'copied' flash gives the click a visible echo
             without needing a toast system. -->
        <button
          class="sw-btn ghost svc-share"
          type="button"
          :title="shareCopied ? t('Link copied') : t('Copy a shareable link to the current view')"
          @click="copyShareLink"
        >
          <Icon name="share" />
          <span v-if="shareCopied" class="svc-share-flash">{{ t('copied') }}</span>
        </button>
        <!-- Per-service events — open the popout scoped to THIS service so the
             operator sees its instances without leaving the layer. Gated on
             events:read so it never opens a modal whose query would 403.
             Passes the FULL OAP service NAME (events filter on the literal
             `<group>::<base>` name, not the group-stripped display label). -->
        <button
          v-if="auth.hasVerb('events:read') && selectedRow?.serviceName"
          class="sw-btn ghost svc-events"
          type="button"
          :title="t('View events for {name}', { name: selectedName })"
          @click="() => eventsPopout.open(layerKey, selectedRow!.serviceName)"
        >
          <Icon name="event" />
        </button>
        <div v-if="serviceKpis.length > 0" class="kpi-strip service-kpis">
          <div v-for="(k, i) in serviceKpis" :key="i" class="kpi compact">
            <span class="kpi-label inline">
              {{ k.label }}<span v-if="k.unit" class="unit">({{ k.unit }})</span>
            </span>
            <span class="kpi-value inline" :style="{ color: k.color }">
              <span :class="{ muted: k.value == null }">{{ fmtMetric(k.value) }}</span><span
                v-if="kpiStale && k.value != null"
                class="kpi-hour-mark"
              >*</span>
            </span>
          </div>
        </div>
      </div>
    </header>

    <!-- Picker dropdown — only visible when the Switch button is open.
         Sits below the General header so the page reads top-to-bottom:
         layer identity → expanded service picker → sub-route body. -->
    <LayerServiceSelector
      v-if="layer && pickerOpen && (sampledServices.length > 0 || fullRoster.length > 0) && !viewOwnsServiceSelector"
      :services="sampledServices"
      :kpi-hour-label="kpiHourLabel"
      :kpi-hour-stale="kpiStale"
      :kpi-hour-partial="kpiPartial"
      :roster="fullRoster"
      :order-by="safeCfg.orderBy"
      :columns="selectorColumns"
      :selected-id="selectedId"
      :accent="layer.color"
      :naming-rule="layer.naming ?? null"
      :service-label="serviceSlotLabel"
      :lock-enabled="comparable"
      :locked-ids="lockedServiceIds"
      :scope-filter="pageScopeFilter"
      @select="pickService"
      @toggle-lock="toggleLockService"
    />

    <!-- Loading state for the menu fetch — appears in the login →
         layer-URL redirect window where the menu is still in flight
         and we can't yet tell whether the layer exists. -->
    <div v-if="menuStillLoading || previewLoading" class="missing">
      <div class="sw-card missing-card">
        <Icon name="event" :size="18" />
        <div>
          <h2>{{ t('Loading layers…') }}</h2>
          <p>{{ t('Resolving') }} <code>{{ layerKey }}</code> {{ t('against the OAP layer registry.') }}</p>
        </div>
      </div>
    </div>
    <!-- Not in the registry. Only shown once the menu fetch has settled
         with a non-empty result; avoids the post-login "Layer not found"
         flash. The duplicate case gets its own card — that layer is
         neither inactive nor unknown, it has two definitions on OAP. -->
    <div v-else-if="layerMissing" class="missing">
      <div v-if="missingReason === 'duplicated'" class="sw-card missing-card">
        <Icon name="alert" :size="18" />
        <div>
          <h2>{{ t('Layer dashboard is duplicated') }}</h2>
          <p>
            {{ t('More than one enabled OAP record holds the dashboard template for') }} <code>{{ layerKey }}</code>.
            {{ t('Which definition to render is ambiguous, so Horizon hides the layer and changes nothing on its own. Retire the extra record on OAP to bring it back.') }}
          </p>
          <p class="missing-links">
            <RouterLink v-if="canOpenLayerTemplates" to="/admin/layer-dashboards">
              {{ t('Dashboard setup → Layer dashboards') }}
            </RouterLink>
            <RouterLink to="/">{{ t('Back to Overview') }}</RouterLink>
          </p>
        </div>
      </div>
      <div v-else class="sw-card missing-card">
        <Icon name="alert" :size="18" />
        <div>
          <h2>{{ t('Layer not found') }}</h2>
          <p>
            {{ t('No OAP layer matches') }} <code>{{ layerKey }}</code>. {{ t('The layer may be inactive or unknown.') }}
            <RouterLink to="/">{{ t('Back to Overview') }}</RouterLink>.
          </p>
        </div>
      </div>
    </div>

    <!-- Sub-route body. No tab strip — operators navigate via the
         per-layer entries in the left sidebar. -->
    <div v-if="layer" class="tab-body">
      <RouterView />
    </div>

  </div>
</template>

<style scoped>
.kpi-partial {
  margin: 0 0 8px;
  padding: 8px 12px;
  background: var(--sw-warn-soft);
  border: 1px solid var(--sw-warn);
  border-radius: 6px;
  color: var(--sw-warn);
  font-size: 11.5px;
}
.kpi-hour-note {
  font-size: 11px;
  color: var(--sw-text-dim);
  margin-bottom: 2px;
}
.kpi-hour-mark {
  color: var(--sw-text-dim);
  font-weight: 600;
  margin-left: 2px;
}
.svc-refresh {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.svc-refresh :deep(svg.spin) {
  animation: svc-refresh-spin 0.9s linear infinite;
}
@keyframes svc-refresh-spin {
  to { transform: rotate(360deg); }
}
.svc-share {
  position: relative;
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
/* Match the refresh/share icon buttons — the Events deep-link is a
   RouterLink (`<a>`), so it needs the same 32×32 flex box; without it the
   `<a>` shrink-wraps the icon and renders it undersized/off-center. */
.svc-events {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.svc-share-flash {
  position: absolute;
  top: -22px;
  left: 50%;
  transform: translateX(-50%);
  padding: 2px 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--sw-fg-1);
  pointer-events: none;
  white-space: nowrap;
}

.layer-shell {
  padding: 16px 20px 48px;
  max-width: 1440px;
  margin: 0 auto;
}
.layer-head {
  padding: 14px;
  margin-bottom: 14px;
}
.layer-id-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.identity-text {
  min-width: 0;
}
.service-row {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed var(--sw-line);
}
.service-kpis {
  margin-left: auto;
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  align-items: baseline;
}
.kpi.compact {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  text-align: left;
  min-width: 0;
}
.kpi-label.inline {
  font-size: 9.5px;
  margin-bottom: 0;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
}
.kpi-value.inline {
  font-size: 13px;
  font-weight: 600;
}
.switch {
  /* Merged Switch button — sits at the start of the service row, ahead
   * of the KPI strip. Click opens the picker dropdown below. */
  height: 32px;
  padding: 0 12px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  font-weight: 500;
  border-color: var(--sw-line-2);
}
.switch:hover {
  background: var(--sw-bg-2);
}
.switch.open {
  background: var(--sw-bg-2);
  border-color: var(--sw-line-3);
}
.switch .caret {
  font-size: 10px;
  color: var(--sw-fg-3);
  transition: transform 0.12s;
}
.switch.open .caret {
  transform: rotate(180deg);
}
.switch .svc-name {
  font-family: var(--sw-mono);
  color: var(--sw-fg-0);
  letter-spacing: -0.01em;
}
/* Group chip on the Switch button — surfaces OAP's `<group>::<base>`
   prefix so the base name reads clean (e.g. `[agent] rating` instead
   of `agent::rating`). */
.switch .svc-group {
  display: inline-block;
  margin-right: 6px;
  padding: 1px 6px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--sw-fg-2);
  text-transform: uppercase;
  vertical-align: middle;
}

.icon-tile {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  color: #fff;
  font-weight: 700;
  font-size: 14px;
  letter-spacing: -0.02em;
  flex: 0 0 40px;
  /* Layer color is intentionally bright; mix with a darker overlay so
   * white initials stay legible across the palette range. */
  background-blend-mode: multiply;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
}
.title-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.title-row h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--sw-fg-0);
  letter-spacing: -0.02em;
}
.layer-tag {
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
  border-color: var(--sw-accent-line);
}
.sub {
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--sw-fg-3);
}
.sub a {
  color: var(--sw-accent-2);
  text-decoration: none;
  margin-left: 4px;
}
.kpi-strip {
  display: flex;
  gap: 22px;
  flex-wrap: wrap;
  align-items: flex-end;
  margin-left: auto;
}
.kpi {
  text-align: right;
  min-width: 80px;
}
.kpi-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
  margin-bottom: 2px;
}
.kpi-label .unit {
  text-transform: none;
  letter-spacing: 0;
  margin-left: 2px;
  font-size: 9.5px;
}
.kpi-value {
  font-size: 18px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
}
.kpi-value .muted {
  color: var(--sw-fg-3);
}
.kpi-value > span:first-child {
  /* Inherit color from the parent .kpi-value style binding (per-metric
   * color band) — the muted modifier below overrides when value is null. */
  color: inherit;
}
.kpi-unit {
  font-size: 10px;
  color: var(--sw-fg-3);
  margin-left: 2px;
}
.kpi-spark {
  display: block;
  margin-top: 4px;
  margin-left: auto;
}
.kpi-spark-empty {
  display: block;
  height: 16px;
  margin-top: 4px;
}
.tab-body {
  /* Sub-routes own their own internal layout / padding. */
  min-height: 200px;
}
.missing {
  padding: 40px 0;
}
.missing-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 20px;
  max-width: 540px;
  margin: 0 auto;
}
.missing-card h2 {
  margin: 0 0 4px;
  font-size: 14px;
  color: var(--sw-fg-0);
}
.missing-card p {
  margin: 0;
  font-size: 11.5px;
  color: var(--sw-fg-2);
  line-height: 1.5;
}
.missing-card code {
  font-family: var(--sw-mono);
  font-size: 10.5px;
  background: var(--sw-bg-2);
  padding: 1px 4px;
  border-radius: 3px;
}
.missing-card a {
  color: var(--sw-accent-2);
  text-decoration: none;
}
.missing-card .missing-links {
  display: flex;
  gap: 14px;
  margin-top: 6px;
}
</style>
