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
import { computed } from 'vue';
import { useRoute, useRouter, RouterLink } from 'vue-router';
import type { LandingServiceRow, LayerDef } from '@skywalking-horizon-ui/api-client';
import LayerConstellation from './LayerConstellation.vue';
import { metricMeta } from '@/composables/metricCatalog';
import { useLayerLanding } from '@/composables/useLayerLanding';
import { useLayers } from '@/composables/useLayers';
import { useSetupStore } from '@/stores/setup';
import { fmtMetric } from '@/utils/formatters';

const route = useRoute();
const router = useRouter();
const layerKey = computed(() => String(route.params.layerKey ?? ''));

function openService(row: LandingServiceRow): void {
  router.push(`/layer/${layerKey.value}/services/${encodeURIComponent(row.serviceId)}`);
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
// long tail shows. The table reuses the topN slice; Stage 2.9 will
// upgrade this to a paginated browse of all sampled rows.
const sampled = computed(() => landing.data.value?.sampledRows ?? landing.rows.value ?? []);
const topRows = computed(() => landing.rows.value ?? []);

const trafficMetric = computed(() => cfg.value?.landing.orderBy ?? 'cpm');
const errorMetric = computed(() => {
  // Prefer a column with 'err'-shaped semantics; otherwise fall through
  // to the orderBy metric (constellation degrades gracefully — all dots
  // render as 'ok' if the error metric isn't in the column set).
  const cols = cfg.value?.landing.columns ?? [];
  const match = cols.find((c) =>
    /err|sla/.test(c.metric.toLowerCase()),
  );
  return match?.metric ?? 'err';
});
const reachable = computed(() => landing.data.value?.reachable !== false);
</script>

<template>
  <div class="services-tab">
    <div v-if="!reachable" class="banner err">
      <strong>OAP unreachable.</strong>
      Live service data is unavailable for this layer. Showing what's cached.
    </div>

    <div class="grid">
      <section class="sw-card">
        <div class="card-head">
          <h4>Service health constellation</h4>
          <span class="sub">angle · service order ⋅ radius · log({{ trafficMetric }}) ⋅ color · {{ errorMetric }} band</span>
        </div>
        <div class="card-body">
          <LayerConstellation
            v-if="sampled.length > 0"
            :services="sampled"
            :traffic-metric="trafficMetric"
            :error-metric="errorMetric"
            @pick="openService"
          />
          <p v-else-if="landing.isLoading.value" class="empty">Loading services…</p>
          <p v-else class="empty">
            No services reporting on this layer yet. Once data flows the constellation lights up
            automatically.
          </p>
        </div>
      </section>

      <section class="sw-card services-table-card">
        <div class="card-head">
          <h4>Top services</h4>
          <span class="sub">{{ topRows.length }} of {{ sampled.length }} shown · sorted by {{ trafficMetric }}</span>
          <RouterLink class="all-link" to="/setup">Customize</RouterLink>
        </div>
        <table v-if="topRows.length > 0" class="sw-table">
          <thead>
            <tr>
              <th class="svc-col">Service</th>
              <th
                v-for="c in cfg?.landing.columns ?? []"
                :key="c.metric"
                class="num"
                :title="`${metricMeta(c.metric).longLabel}\n\n${metricMeta(c.metric).tip}`"
              >
                {{ c.label }}<span v-if="c.unit" class="unit">{{ c.unit }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in topRows" :key="row.serviceId" class="clickable" @click="openService(row)">
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

        <p class="phase-note">
          Full sortable + paginated services table lands in Stage 2.9. For now the top {{ topRows.length || 5 }}
          appear above, identical to the Overview card row.
        </p>
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
