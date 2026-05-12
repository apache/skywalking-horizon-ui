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
  Services tab body for the per-layer page. Renders the constellation
  visualization (Stage 2.8) over the sampled service set and lists
  services in a table below (Stage 2.9 — currently a structural
  placeholder while the table column model finalizes).

  Data flows in from the shared /api/layer/:key/landing endpoint via
  useLayerLanding — same query the Overview card already runs, so the
  data is cached and shared between the two views.
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, RouterLink } from 'vue-router';
import type { LandingServiceRow, LayerDef } from '@skywalking-horizon-ui/api-client';
import { metricMeta } from '@/composables/metricCatalog';
import { useLayerLanding } from '@/composables/useLayerLanding';
import { useLayers } from '@/composables/useLayers';
import { useSelectedService } from '@/composables/useSelectedService';
import { useSetupStore } from '@/stores/setup';
import { fmtMetric } from '@/utils/formatters';

const route = useRoute();
const layerKey = computed(() => String(route.params.layerKey ?? ''));
const { selectedId, setSelected } = useSelectedService();

function openService(row: LandingServiceRow): void {
  setSelected(row.serviceId);
}
const { layers } = useLayers();
const layer = computed<LayerDef | null>(() => layers.value.find((l) => l.key === layerKey.value) ?? null);
const store = useSetupStore();
const cfg = computed(() => {
  if (!layer.value) return null;
  return store.ensure(layer.value.key, { slots: layer.value.slots, caps: layer.value.caps });
});

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

// Constellation uses the full sampled set (up to ~25 services) so the
// long tail shows. Table shows the same set, sortable by any column.
const sampled = computed(() => landing.data.value?.sampledRows ?? landing.rows.value ?? []);

// Table sort state. Defaults to descending on the layer's orderBy
// metric — matches the BFF's pre-sort so the visible order is stable
// when the user hasn't picked a different column yet.
const sortKey = computed(() => cfg.value?.landing.orderBy ?? 'cpm');
const sortMetric = ref<string>(sortKey.value);
const sortDir = ref<'asc' | 'desc'>('desc');
function setSort(metric: string): void {
  if (sortMetric.value === metric) {
    sortDir.value = sortDir.value === 'desc' ? 'asc' : 'desc';
  } else {
    sortMetric.value = metric;
    sortDir.value = 'desc';
  }
}
const sortedRows = computed(() => {
  const rows = [...sampled.value];
  const key = sortMetric.value;
  const dir = sortDir.value === 'desc' ? -1 : 1;
  rows.sort((a, b) => {
    const av = a.metrics[key];
    const bv = b.metrics[key];
    if (av == null && bv == null) return a.serviceName.localeCompare(b.serviceName);
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av - bv) * dir;
  });
  return rows;
});

// Apdex distribution — bucket counts driven by the standard apdex
// bands. When no apdex column exists in the setup, the right column
// drops the tile so we don't show a hard-coded zero.
const apdexBuckets = computed(() => {
  const buckets = [
    { label: '0.95 – 1.00', min: 0.95, color: 'var(--sw-ok)', count: 0 },
    { label: '0.85 – 0.95', min: 0.85, color: 'var(--sw-info)', count: 0 },
    { label: '0.70 – 0.85', min: 0.70, color: 'var(--sw-warn)', count: 0 },
    { label: '< 0.70', min: -Infinity, color: 'var(--sw-err)', count: 0 },
  ];
  for (const row of sampled.value) {
    const v = row.metrics['apdex'];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    for (const b of buckets) {
      if (v >= b.min) {
        b.count++;
        break;
      }
    }
  }
  return buckets;
});
const hasApdex = computed(() =>
  (cfg.value?.landing.columns ?? []).some((c) => c.metric === 'apdex'),
);
const totalApdex = computed(() => apdexBuckets.value.reduce((a, b) => a + b.count, 0));

const reachable = computed(() => landing.data.value?.reachable !== false);
</script>

<template>
  <div class="services-tab">
    <div v-if="!reachable" class="banner err">
      <strong>OAP unreachable.</strong>
      Live service data is unavailable for this layer. Showing what's cached.
    </div>

    <div class="grid">
      <section class="sw-card services-table-card">
        <div class="card-head">
          <h4>Services in this layer</h4>
          <span class="sub">{{ sampled.length }} sampled · click a column to re-sort · row click selects</span>
          <RouterLink class="all-link" to="/setup">Customize</RouterLink>
        </div>
        <table v-if="sortedRows.length > 0" class="sw-table">
          <thead>
            <tr>
              <th class="svc-col">Service</th>
              <th
                v-for="c in cfg?.landing.columns ?? []"
                :key="c.metric"
                class="num sortable"
                :class="{ on: sortMetric === c.metric }"
                :title="`${metricMeta(c.metric).longLabel}\n\n${metricMeta(c.metric).tip}`"
                @click="setSort(c.metric)"
              >
                {{ c.label }}<span v-if="c.unit" class="unit">{{ c.unit }}</span>
                <span v-if="sortMetric === c.metric" class="caret">{{ sortDir === 'desc' ? '▼' : '▲' }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in sortedRows"
              :key="row.serviceId"
              class="clickable"
              :class="{ active: row.serviceId === selectedId }"
              @click="openService(row)"
            >
              <td class="svc-col" :title="row.serviceName">
                <span class="svc-link">{{ row.shortName || row.serviceName }}</span>
              </td>
              <td
                v-for="c in cfg?.landing.columns ?? []"
                :key="c.metric"
                class="num"
                :class="{ muted: row.metrics[c.metric] == null }"
              >
                {{ fmtMetric(row.metrics[c.metric]) }}
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else-if="landing.isLoading.value" class="empty">Loading…</p>
        <p v-else class="empty">No services to show.</p>
      </section>

      <section v-if="hasApdex && totalApdex > 0" class="sw-card apdex-card">
        <div class="card-head">
          <h4>Apdex distribution</h4>
          <span class="sub">services bucketed</span>
        </div>
        <div class="apdex-body">
          <div v-for="b in apdexBuckets" :key="b.label" class="apdex-row">
            <span class="sw-tag">{{ b.label }}</span>
            <div class="bar">
              <div
                class="bar-fill"
                :style="{ width: `${(b.count / totalApdex) * 100}%`, background: b.color }"
              />
            </div>
            <span class="count">{{ b.count }}</span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.services-tab {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px 0 0;
}
.banner.err {
  padding: 8px 12px;
  background: var(--sw-err-soft);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  color: #f87171;
  font-size: 11.5px;
}
.grid {
  display: grid;
  grid-template-columns: 1.2fr 1fr;
  gap: 14px;
  align-items: start;
}
.card-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
}
.card-head h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--sw-fg-0);
  letter-spacing: -0.01em;
}
.card-head .sub {
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.card-head .all-link {
  margin-left: auto;
  font-size: 11px;
  color: var(--sw-accent-2);
  text-decoration: none;
}
.card-body {
  padding: 14px;
}
.empty {
  margin: 0;
  padding: 24px 8px;
  text-align: center;
  font-size: 11.5px;
  color: var(--sw-fg-3);
}
.services-table-card .sw-table th {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
  text-align: left;
  font-weight: 500;
}
.services-table-card .sw-table th.num,
.services-table-card .sw-table td.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.services-table-card .sw-table td {
  font-size: 11.5px;
  color: var(--sw-fg-1);
  padding: 6px 10px;
  border-bottom: 1px solid var(--sw-line);
}
.services-table-card .sw-table td.muted {
  color: var(--sw-fg-3);
}
.services-table-card .sw-table tr.clickable {
  cursor: pointer;
}
.services-table-card .sw-table tr.clickable:hover {
  background: var(--sw-bg-2);
}
.svc-link {
  color: var(--sw-fg-0);
}
.services-table-card .sw-table tr.clickable:hover .svc-link {
  color: var(--sw-accent-2);
}
.services-table-card .sw-table tr.clickable.active {
  background: var(--sw-accent-soft);
}
.services-table-card .sw-table tr.clickable.active .svc-link {
  color: var(--sw-accent-2);
  font-weight: 600;
}
.services-table-card .sw-table th.sortable {
  cursor: pointer;
  user-select: none;
}
.services-table-card .sw-table th.sortable:hover {
  color: var(--sw-fg-1);
}
.services-table-card .sw-table th.sortable.on {
  color: var(--sw-accent-2);
}
.services-table-card .sw-table th .caret {
  margin-left: 3px;
  font-size: 9px;
}
.apdex-card .card-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
}
.apdex-card .card-head h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--sw-fg-0);
}
.apdex-card .card-head .sub {
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.apdex-body {
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.apdex-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.apdex-row .sw-tag {
  width: 96px;
  font-size: 10px;
  text-align: center;
}
.apdex-row .bar {
  flex: 1;
  height: 6px;
  background: var(--sw-bg-3);
  border-radius: 3px;
  overflow: hidden;
}
.apdex-row .bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.2s ease-out;
}
.apdex-row .count {
  width: 30px;
  text-align: right;
  font-family: var(--sw-mono);
  font-size: 10.5px;
  color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
}
.svc-col {
  max-width: 200px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
th .unit {
  margin-left: 3px;
  color: var(--sw-fg-3);
  font-weight: 400;
}
.phase-note {
  margin: 0;
  padding: 10px 14px;
  font-size: 10.5px;
  color: var(--sw-fg-3);
  border-top: 1px dashed var(--sw-line);
  background: var(--sw-bg-1);
}

@media (max-width: 1100px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
