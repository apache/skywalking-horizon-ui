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
import { computed } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';
import type { LayerDef } from '@skywalking-horizon-ui/api-client';
import Icon from '@/components/icons/Icon.vue';
import LayerServiceSelector from './LayerServiceSelector.vue';
import { metricMeta } from '@/composables/metricCatalog';
import { useLayerLanding } from '@/composables/useLayerLanding';
import { useLayers } from '@/composables/useLayers';
import { useSelectedService } from '@/composables/useSelectedService';
import { useSetupStore } from '@/stores/setup';
import { fmtMetric } from '@/utils/formatters';

const route = useRoute();
const layerKey = computed(() => String(route.params.layerKey ?? ''));
const { layers, hasTopology } = useLayers();
const layer = computed<LayerDef | null>(() => {
  const found = layers.value.find((l) => l.key === layerKey.value);
  return found ?? null;
});
const store = useSetupStore();
const cfg = computed(() => {
  if (!layer.value) return null;
  return store.ensure(layer.value.key, { slots: layer.value.slots, caps: layer.value.caps });
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
interface Tab {
  to: string;
  label: string;
  icon?: string;
}
const tabs = computed<Tab[]>(() => {
  if (!layer.value) return [];
  const L = layer.value;
  const out: Tab[] = [];
  const base = `/layer/${L.key}`;
  if (L.slots.services) out.push({ to: `${base}/services`, label: cfg.value?.slots.services || L.slots.services || 'Services' });
  if (L.slots.instances) out.push({ to: `${base}/instances`, label: cfg.value?.slots.instances || L.slots.instances });
  if (L.slots.endpoints) out.push({ to: `${base}/endpoints`, label: cfg.value?.slots.endpoints || L.slots.endpoints });
  if (hasTopology(L)) out.push({ to: `${base}/topology`, label: 'Topology' });
  if (L.caps.endpointDependency) {
    out.push({
      to: `${base}/dependency`,
      label: cfg.value?.slots.endpointDependency || `${cfg.value?.slots.endpoints || 'Endpoint'} dependency`,
    });
  }
  if (L.caps.dashboards) out.push({ to: `${base}/dashboards`, label: 'Dashboards' });
  if (L.caps.traces) out.push({ to: `${base}/traces`, label: 'Traces' });
  if (L.caps.logs) out.push({ to: `${base}/logs`, label: 'Logs' });
  if (L.caps.profiling) out.push({ to: `${base}/profiling`, label: 'Profiling' });
  // `events` cap intentionally omitted — operators rely on the sidebar
  // for cross-cutting event views; per-layer Events will get its own
  // design pass later.
  return out;
});

function isTabActive(to: string): boolean {
  return route.path === to || route.path.startsWith(to + '/');
}

// ── Header KPI strip ─────────────────────────────────────────────────
// Picks at most 5 metrics from the layer's setup columns; service count
// always leads. Each KPI is read from /api/layer/:key/landing.aggregates,
// so it's the same value the Overview tile shows.
interface HeaderKpi {
  label: string;
  value: number | null;
  unit?: string;
  color?: string;
  isService?: boolean;
}
const headerKpis = computed<HeaderKpi[]>(() => {
  const L = layer.value;
  if (!L) return [];
  const c = cfg.value;
  if (!c) return [];
  const a = aggregates.value;
  const svcCount = a?.serviceCount ?? L.serviceCount;
  const out: HeaderKpi[] = [
    { label: c.slots.services || 'Services', value: svcCount, color: L.color, isService: true },
  ];
  for (const col of c.landing.columns.slice(0, 5)) {
    const m = metricMeta(col.metric);
    out.push({
      label: col.label || m.label,
      value: a?.metrics?.[col.metric] ?? null,
      unit: col.unit || m.unit,
    });
  }
  return out;
});

// Source/level chip text (mirrors design's "from Java agent · OAP v10.3").
const sourceText = computed(() => {
  if (!layer.value) return '';
  const lvl = layer.value.level;
  return lvl !== null && lvl !== undefined ? `OAP layer · level ${lvl}` : 'OAP layer';
});
</script>

<template>
  <div class="layer-shell">
    <header v-if="layer" class="sw-card layer-head">
      <div class="head-row">
        <div class="identity">
          <div class="icon-tile" :style="{ background: layer.color }">{{ initials }}</div>
          <div class="identity-text">
            <div class="title-row">
              <h1>{{ displayName }}</h1>
              <span class="sw-tag layer-tag">LAYER</span>
              <span class="sw-tag">{{ sourceText }}</span>
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
        </div>
        <div class="kpi-strip">
          <div v-for="(k, i) in headerKpis" :key="i" class="kpi">
            <div class="kpi-label">{{ k.label }}</div>
            <div class="kpi-value" :style="k.color && k.isService ? { color: k.color } : undefined">
              <span :class="{ muted: k.value == null }">{{ fmtMetric(k.value) }}</span>
              <span v-if="k.unit" class="kpi-unit">{{ k.unit }}</span>
            </div>
          </div>
        </div>
      </div>

    </header>

    <!-- Service selector sits between the layer header and the tab
         strip — operators pick context first, then drill into the
         specific tab they want. Selection (URL ?service=) carries
         across every tab. -->
    <LayerServiceSelector
      v-if="layer && sampledServices.length > 0"
      :services="sampledServices"
      :columns="selectorColumns"
      :selected-id="selectedId"
      :accent="layer.color"
      @select="setSelected"
    />

    <nav v-if="layer && tabs.length > 0" class="sw-card tab-strip-wrap">
      <div class="tab-strip">
        <RouterLink
          v-for="t in tabs"
          :key="t.to"
          :to="t.to"
          class="tab"
          :class="{ on: isTabActive(t.to) }"
        >
          {{ t.label }}
        </RouterLink>
      </div>
    </nav>

    <div v-else class="missing">
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

    <div v-if="layer" class="tab-body">
      <LayerServiceSelector
        v-if="sampledServices.length > 0"
        :services="sampledServices"
        :columns="selectorColumns"
        :selected-id="selectedId"
        :accent="layer.color"
        @select="setSelected"
      />
      <RouterView />
    </div>
  </div>
</template>

<style scoped>
.layer-shell {
  padding: 16px 20px 48px;
  max-width: 1440px;
  margin: 0 auto;
}
.layer-head {
  padding: 14px;
  margin-bottom: 14px;
}
.head-row {
  display: flex;
  align-items: flex-start;
  gap: 18px;
  flex-wrap: wrap;
}
.identity {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  flex: 1 1 320px;
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
.identity-text {
  min-width: 0;
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
  gap: 20px;
  flex-wrap: wrap;
  align-items: flex-end;
  margin-left: auto;
}
.kpi {
  text-align: right;
  min-width: 60px;
}
.kpi-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
  margin-bottom: 2px;
}
.kpi-value {
  font-size: 17px;
  font-weight: 600;
  color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
}
.kpi-value .muted {
  color: var(--sw-fg-3);
}
.kpi-unit {
  font-size: 10px;
  color: var(--sw-fg-3);
  margin-left: 2px;
}
.tab-strip-wrap {
  margin-bottom: 14px;
  padding: 0;
}
.tab-strip {
  display: flex;
  gap: 2px;
  padding: 0 14px;
  overflow-x: auto;
}
.tab {
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--sw-fg-2);
  text-decoration: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  white-space: nowrap;
  transition: color 0.12s, border-color 0.12s;
}
.tab:hover {
  color: var(--sw-fg-1);
}
.tab.on {
  color: var(--sw-fg-0);
  font-weight: 600;
  border-bottom-color: var(--sw-accent);
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
