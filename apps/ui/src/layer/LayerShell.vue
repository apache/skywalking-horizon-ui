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
import { computed, ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import type { LayerDef } from '@skywalking-horizon-ui/api-client';
import Icon from '@/components/icons/Icon.vue';
import Sparkline from '@/components/charts/Sparkline.vue';
import LayerServiceSelector from './LayerServiceSelector.vue';
import { metricMeta } from '@/utils/metricCatalog';
import { colorForMetric } from '@/utils/metricColor';
import { useLayerLanding } from '@/layer/useLayerLanding';
import { useLayers, firstLayerTab } from '@/shell/useLayers';
import { useSelectedService } from '@/layer/useSelectedService';
import { useSetupStore } from '@/state/setup';
import { fmtMetric } from '@/utils/formatters';
import { parseServiceName } from '@/utils/serviceName';

const route = useRoute();
const router = useRouter();
const layerKey = computed(() => String(route.params.layerKey ?? ''));
const { layers, isLoading: layersLoading } = useLayers();
const layer = computed<LayerDef | null>(() => {
  const found = layers.value.find((l) => l.key === layerKey.value);
  return found ?? null;
});
// Distinguishes "still loading" from "truly absent" so the "Layer
// not found" card doesn't flash during a login → layer-URL redirect
// (the menu fetch is in-flight and `layers.value` is briefly []).
// We treat the layer as missing only after the menu request has
// settled AND the layer key still isn't in the result.
const layerMissing = computed<boolean>(
  () => !layersLoading.value && layers.value.length > 0 && layer.value === null,
);
const menuStillLoading = computed<boolean>(
  () => !layer.value && (layersLoading.value || layers.value.length === 0),
);

// Auto-redirect when the URL targets a sub-route the layer doesn't
// support — e.g. `/layer/mesh_dp/service` on a layer with
// `components.service: false`. Without this the operator lands on an
// empty "No widgets defined" page even though the layer DOES have
// other tabs (Instance / Logs / …). Fires once per change so the
// browser-back button works as expected.
//
// Matrix of route segments that need the layer cap to be present:
//   service     ⇒ caps.dashboards
//   instance    ⇒ slots.instances
//   endpoint    ⇒ slots.endpoints
//   topology    ⇒ caps.serviceMap | caps.instanceTopology | caps.processTopology
//   dependency  ⇒ caps.endpointDependency
//   trace       ⇒ caps.traces
//   logs        ⇒ caps.logs
//   *-profiling ⇒ caps.*Profiling
const SCOPE_CAP_PREDICATE: Record<string, (L: LayerDef) => boolean> = {
  service: (L) => Boolean(L.caps?.dashboards),
  instance: (L) => Boolean(L.slots?.instances),
  endpoint: (L) => Boolean(L.slots?.endpoints),
  topology: (L) => Boolean(L.caps?.serviceMap || L.caps?.instanceTopology || L.caps?.processTopology),
  dependency: (L) => Boolean(L.caps?.endpointDependency),
  trace: (L) => Boolean(L.caps?.traces),
  logs: (L) => Boolean(L.caps?.logs),
  'trace-profiling': (L) => Boolean(L.caps?.traceProfiling),
  'ebpf-profiling': (L) => Boolean(L.caps?.ebpfProfiling),
  'async-profiling': (L) => Boolean(L.caps?.asyncProfiling),
  'network-profiling': (L) => Boolean(L.caps?.networkProfiling),
  pprof: (L) => Boolean(L.caps?.pprofProfiling),
};
watch(
  [() => route.path, layer],
  ([path, L]) => {
    if (!L) return;
    const m = path.match(/^\/layer\/[^/]+\/([^/?]+)/);
    if (!m) return;
    const scope = m[1];
    const predicate = SCOPE_CAP_PREDICATE[scope];
    if (!predicate) return; // unknown scope — let the router resolve
    if (predicate(L)) return; // layer supports this scope, nothing to do
    const fallback = firstLayerTab(L);
    if (fallback === scope) return; // already at the best fallback
    void router.replace({ path: `/layer/${L.key}/${fallback}`, query: route.query });
  },
  { immediate: true },
);
const store = useSetupStore();
const cfg = computed(() => {
  if (!layer.value) return null;
  return store.ensure(layer.value.key, { slots: layer.value.slots, caps: layer.value.caps, metrics: layer.value.metrics, overview: layer.value.overview });
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
  style: 'table' as const,
});
const landing = useLayerLanding(safeLayer, safeCfg);
const aggregates = computed(() => landing.data.value?.aggregates ?? null);

// Page-wide selected service — URL-backed, shared with every tab body.
const { selectedId, setSelected } = useSelectedService();
const sampledServices = computed(() => landing.data.value?.sampledRows ?? landing.rows.value ?? []);
const selectorColumns = computed(() => safeCfg.value.columns);
const selectedRow = computed(
  () =>
    sampledServices.value.find((s) => s.serviceId === selectedId.value) ??
    sampledServices.value[0] ??
    null,
);
const selectedParsed = computed(() => parseServiceName(selectedRow.value?.serviceName));
const selectedGroup = computed(() => selectedParsed.value.group);
// Switch-button label — base name only when the service has a group
// prefix (`<group>::<base>` from OAP). The group is rendered as a
// separate chip next to the caret so the user reads it without the
// raw `::` syntax bleeding into the UI.
const selectedName = computed(() => {
  if (selectedRow.value) return selectedParsed.value.base;
  return sampledServices.value.length > 0 ? 'pick a service' : '—';
});

// Routes can declare `meta: { ownsServiceSelector: true }` to opt out
// of the shell-level service picker. Topology is the canonical example
// (its in-box focus selector is the right place to scope the map);
// future component-driven views (dashboards with their own filters,
// say) can flip the same meta flag without touching this file.
const viewOwnsServiceSelector = computed(() => Boolean(route.meta?.ownsServiceSelector));

// Keep the URL-backed service selection honest for every page that
// uses the shell picker. A stale `?service=` can survive navigation or
// manual URL entry; the switch label used to fall back visually to the
// first row while the metric query still waited for a valid service.
watch(
  [sampledServices, selectedId, viewOwnsServiceSelector],
  ([rows, id, ownsSelector]) => {
    if (ownsSelector) return;
    const first = rows[0];
    if (!first) return;
    if (!id || !rows.some((s) => s.serviceId === id)) {
      setSelected(first.serviceId);
    }
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

// ── Header identity ──────────────────────────────────────────────────
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

// ── Tabs ─────────────────────────────────────────────────────────────
// ── Header KPI strip ─────────────────────────────────────────────────
// Picks at most 5 metrics from the layer's setup columns; service count
// always leads. Each KPI is read from /api/layer/:key/landing.aggregates,
// so it's the same value the Overview tile shows.
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
  // Prefer the operator-defined header set (`headerColumns`) over the
  // combined `columns` array — the combined set carries overview
  // promotions that aren't real service-level KPIs. Falls back to
  // `columns` for legacy persisted configs that pre-date this field.
  const headerCols = c.landing.headerColumns ?? c.landing.columns;
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
  const headerCols = c.landing.headerColumns ?? c.landing.columns;
  for (const col of headerCols.slice(0, 5)) {
    const m = metricMeta(col.metric);
    out.push({
      // Catalog label wins when the persisted `col.label` is a
       // stale no-op (raw metric key, lowercase or empty). Operators
       // who set a custom label still get it shown.
      label: col.label && col.label !== col.metric ? col.label : m.label,
      value: row.metrics[col.metric] ?? null,
      unit: col.unit || m.unit,
      color: colorForMetric(col.metric),
    });
  }
  return out;
});

</script>

<template>
  <div class="layer-shell">
    <header v-if="layer" class="sw-card layer-head">
      <!-- Row 1: layer identity (left) + LAYER aggregate KPI strip
           (right). The aggregates use sum/avg per the JSON columns'
           aggregation field — sum cpm across services, avg p99 etc. -->
      <div class="layer-id-row">
        <div class="icon-tile" :style="{ background: layer.color }">{{ initials }}</div>
        <div class="identity-text">
          <div class="title-row">
            <h1>{{ displayName }}</h1>
            <span v-if="layer.serviceCount === 0" class="sw-badge warn">no services</span>
            <span v-else-if="!layer.active" class="sw-badge">no data</span>
          </div>
          <div class="sub">
            {{ layer.serviceCount >= 0 ? `${layer.serviceCount} ${(cfg?.slots.services || 'services').toLowerCase()}` : 'no service data' }}
            <span v-if="layer.documentLink">·
              <a :href="layer.documentLink" target="_blank" rel="noopener noreferrer">docs ↗</a>
            </span>
          </div>
        </div>
        <div v-if="layerKpis.length > 0" class="kpi-strip layer-kpis">
          <div v-for="(k, i) in layerKpis" :key="i" class="kpi">
            <div class="kpi-label">
              {{ k.label }}<span v-if="k.unit" class="unit">({{ k.unit }})</span>
            </div>
            <div class="kpi-value" :style="{ color: k.color }">
              <span :class="{ muted: k.value == null }">{{ fmtMetric(k.value) }}</span>
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
          :title="landing.isFetching.value ? 'Refreshing service list…' : 'Refresh service list'"
          :disabled="landing.isFetching.value"
          @click="() => landing.refetch()"
        >
          <Icon name="refresh" :class="{ spin: landing.isFetching.value }" />
        </button>
        <div v-if="serviceKpis.length > 0" class="kpi-strip service-kpis">
          <div v-for="(k, i) in serviceKpis" :key="i" class="kpi compact">
            <span class="kpi-label inline">
              {{ k.label }}<span v-if="k.unit" class="unit">({{ k.unit }})</span>
            </span>
            <span class="kpi-value inline" :style="{ color: k.color }">
              <span :class="{ muted: k.value == null }">{{ fmtMetric(k.value) }}</span>
            </span>
          </div>
        </div>
      </div>
    </header>

    <!-- Picker dropdown — only visible when the Switch button is open.
         Sits below the General header so the page reads top-to-bottom:
         layer identity → expanded service picker → sub-route body. -->
    <LayerServiceSelector
      v-if="layer && pickerOpen && sampledServices.length > 0 && !viewOwnsServiceSelector"
      :services="sampledServices"
      :columns="selectorColumns"
      :selected-id="selectedId"
      :accent="layer.color"
      :naming-rule="layer.naming ?? null"
      @select="pickService"
    />

    <!-- Loading state for the menu fetch — appears in the login →
         layer-URL redirect window where the menu is still in flight
         and we can't yet tell whether the layer exists. -->
    <div v-if="menuStillLoading" class="missing">
      <div class="sw-card missing-card">
        <Icon name="event" :size="18" />
        <div>
          <h2>Loading layers…</h2>
          <p>Resolving <code>{{ layerKey }}</code> against the OAP layer registry.</p>
        </div>
      </div>
    </div>
    <!-- Truly not in the registry. Only shown once the menu fetch
         has settled with a non-empty result; avoids the post-login
         "Layer not found" flash. -->
    <div v-else-if="layerMissing" class="missing">
      <div class="sw-card missing-card">
        <Icon name="alert" :size="18" />
        <div>
          <h2>Layer not found</h2>
          <p>
            No OAP layer matches <code>{{ layerKey }}</code>. The layer may be inactive or unknown.
            <RouterLink to="/">Back to Overview</RouterLink>.
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
</style>
