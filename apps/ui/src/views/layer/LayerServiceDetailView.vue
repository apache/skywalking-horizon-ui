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
  Service-detail view — opens when an operator picks a service from the
  constellation or services table. URL pattern:
    /layer/:layerKey/services/:serviceId

  For Stage 2.8 this is a structural shell: name, breadcrumb back to the
  services list, KPI tiles built from the layer's column setup, and a
  reference card pointing at the deep views (instances / endpoints /
  traces / logs) which will be populated as later phases land them.
-->
<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import type { LayerDef, LandingServiceRow } from '@skywalking-horizon-ui/api-client';
import Icon from '@/components/icons/Icon.vue';
import { metricMeta } from '@/composables/metricCatalog';
import { useLayerLanding } from '@/composables/useLayerLanding';
import { useLayers } from '@/composables/useLayers';
import { useSetupStore } from '@/stores/setup';
import { fmtMetric } from '@/utils/formatters';

const route = useRoute();
const layerKey = computed(() => String(route.params.layerKey ?? ''));
const serviceId = computed(() => String(route.params.serviceId ?? ''));
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

const allRows = computed(() => landing.data.value?.sampledRows ?? landing.rows.value ?? []);
const service = computed<LandingServiceRow | null>(() =>
  allRows.value.find((r) => r.serviceId === serviceId.value) ?? null,
);
const serviceLabel = computed(() => service.value?.serviceName ?? decodeURIComponent(serviceId.value));
const servicesHref = computed(() => `/layer/${layerKey.value}/services`);

interface DeepLink {
  to: string;
  label: string;
  desc: string;
  phase: string;
  enabled: boolean;
}
// Per-service deep links — phase notes match what the layer-level tabs
// expose. Disabled rows surface to the operator what _could_ be
// reachable once the relevant cap is enabled (or once we wire the page).
const deepLinks = computed<DeepLink[]>(() => {
  const L = layer.value;
  const k = layerKey.value;
  const sid = serviceId.value;
  if (!L) return [];
  const links: DeepLink[] = [];
  if (L.slots.instances) {
    links.push({
      to: `/layer/${k}/instances?service=${encodeURIComponent(sid)}`,
      label: cfg.value?.slots.instances || L.slots.instances || 'Instances',
      desc: 'Per-instance metrics, agent status, JVM/process drill.',
      phase: 'Phase 2 / 3',
      enabled: false,
    });
  }
  if (L.slots.endpoints) {
    links.push({
      to: `/layer/${k}/endpoints?service=${encodeURIComponent(sid)}`,
      label: cfg.value?.slots.endpoints || L.slots.endpoints || 'Endpoints',
      desc: 'API endpoints exposed by this service.',
      phase: 'Phase 2 / 3',
      enabled: false,
    });
  }
  if (L.caps.traces) {
    links.push({
      to: `/layer/${k}/traces?service=${encodeURIComponent(sid)}`,
      label: 'Traces',
      desc: 'Trace explorer scoped to this service.',
      phase: 'Phase 5',
      enabled: false,
    });
  }
  if (L.caps.logs) {
    links.push({
      to: `/layer/${k}/logs?service=${encodeURIComponent(sid)}`,
      label: 'Logs',
      desc: 'Log explorer scoped to this service.',
      phase: 'Phase 5',
      enabled: false,
    });
  }
  if (L.caps.dashboards) {
    links.push({
      to: `/layer/${k}/dashboards?service=${encodeURIComponent(sid)}`,
      label: 'Dashboards',
      desc: 'Widget grid for this service’s scope.',
      phase: 'Phase 3',
      enabled: false,
    });
  }
  if (L.caps.profiling) {
    links.push({
      to: `/layer/${k}/profiling?service=${encodeURIComponent(sid)}`,
      label: 'Profiling',
      desc: 'Flame graphs + sampled stacks for this service.',
      phase: 'Phase 8',
      enabled: false,
    });
  }
  return links;
});
</script>

<template>
  <div class="svc-detail">
    <nav class="crumbs">
      <RouterLink :to="servicesHref">
        <Icon name="chev" :size="10" /> Back to {{ cfg?.slots.services || 'services' }}
      </RouterLink>
    </nav>

    <header class="head">
      <h2>{{ serviceLabel }}</h2>
      <span v-if="!service" class="sw-badge">awaiting data</span>
      <span v-else class="sw-tag" :title="serviceId">id · {{ serviceId.slice(0, 12) }}{{ serviceId.length > 12 ? '…' : '' }}</span>
    </header>

    <section v-if="service" class="kpi-row">
      <div
        v-for="col in cfg?.landing.columns ?? []"
        :key="col.metric"
        class="kpi-tile sw-card"
        :title="`${metricMeta(col.metric).longLabel}\n\n${metricMeta(col.metric).tip}`"
      >
        <div class="kpi-label">{{ col.label }}<span v-if="col.unit" class="unit">{{ col.unit }}</span></div>
        <div class="kpi-value" :class="{ muted: service.metrics[col.metric] == null }">
          {{ fmtMetric(service.metrics[col.metric]) }}
        </div>
      </div>
    </section>

    <section v-else class="empty-card sw-card">
      <p>
        No live data found for service <code>{{ serviceId }}</code>.
        It may not be in the current sample — open
        <RouterLink :to="servicesHref">the services list</RouterLink>
        and pick a service from the table.
      </p>
    </section>

    <section class="sw-card deep-links">
      <div class="card-head">
        <h4>Deep dive</h4>
        <span class="sub">scoped to this service · each opens with <code>?service={{ serviceId }}</code></span>
      </div>
      <div class="link-grid">
        <div v-for="L in deepLinks" :key="L.label" class="link-card">
          <div class="link-head">
            <span class="link-label">{{ L.label }}</span>
            <span class="sw-badge">{{ L.phase }}</span>
          </div>
          <p class="link-desc">{{ L.desc }}</p>
        </div>
        <p v-if="deepLinks.length === 0" class="empty">
          No deep-dive views available for this layer&rsquo;s caps.
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.svc-detail {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px 0 0;
}
.crumbs a {
  font-size: 11.5px;
  color: var(--sw-fg-2);
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.crumbs a:hover {
  color: var(--sw-accent-2);
}
.head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
}
.head h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--sw-fg-0);
  letter-spacing: -0.02em;
  font-family: var(--sw-mono);
}
.kpi-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px;
}
.kpi-tile {
  padding: 10px 14px;
}
.kpi-label {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
  margin-bottom: 4px;
}
.kpi-label .unit {
  margin-left: 3px;
  text-transform: none;
  letter-spacing: 0;
  font-size: 9px;
}
.kpi-value {
  font-size: 20px;
  font-weight: 600;
  color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
}
.kpi-value.muted {
  color: var(--sw-fg-3);
}
.empty-card {
  padding: 18px 20px;
  font-size: 11.5px;
  color: var(--sw-fg-2);
  line-height: 1.5;
}
.empty-card code {
  font-family: var(--sw-mono);
  font-size: 10.5px;
  color: var(--sw-fg-2);
  background: var(--sw-bg-2);
  padding: 1px 4px;
  border-radius: 3px;
}
.empty-card a {
  color: var(--sw-accent-2);
  text-decoration: none;
}
.deep-links .card-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
}
.deep-links .card-head h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--sw-fg-0);
}
.deep-links .card-head .sub {
  font-size: 10.5px;
  color: var(--sw-fg-3);
}
.deep-links .card-head .sub code {
  font-family: var(--sw-mono);
  font-size: 10px;
  color: var(--sw-fg-2);
  background: var(--sw-bg-2);
  padding: 0 3px;
  border-radius: 2px;
}
.link-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
  padding: 12px 14px;
}
.link-card {
  background: var(--sw-bg-1);
  border: 1px dashed var(--sw-line-2);
  border-radius: 6px;
  padding: 10px 12px;
}
.link-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
}
.link-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--sw-fg-1);
}
.link-desc {
  margin: 4px 0 0;
  font-size: 10.5px;
  color: var(--sw-fg-3);
  line-height: 1.5;
}
.empty {
  margin: 0;
  font-size: 11.5px;
  color: var(--sw-fg-3);
}
</style>
