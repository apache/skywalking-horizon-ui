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
  Expanded service-picker dropdown — rendered by LayerShell beneath the
  layer header card when the Switch button is open. Search by name +
  pagination over the sampled service set; each row uses the design's
  "Services in this layer" styling (status pulse dot + threshold-colored
  metric cells). Picking a row emits `select(id)`, which LayerShell uses
  to update the URL `?service=` state and close the dropdown.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { LandingColumn, LandingServiceRow } from '@skywalking-horizon-ui/api-client';

const { t } = useI18n({ useScope: 'global' });
import { metricMeta } from '@/utils/metricCatalog';
import { statusForMetrics, thresholdColor } from '@/utils/metricColor';
import { fmtMetric } from '@/utils/formatters';
import { resolveServiceIdentity } from '@/utils/serviceName';
import type { ServiceNamingRule } from '@skywalking-horizon-ui/api-client';

const props = withDefaults(
  defineProps<{
    services: ReadonlyArray<LandingServiceRow>;
    columns: ReadonlyArray<LandingColumn>;
    selectedId: string | null;
    accent?: string;
    pageSize?: number;
    /** Per-layer topology-cluster rule. When supplied, rows render a
     *  cluster chip; when null, no chip. The OAP `<group>::` legacy
     *  prefix is always stripped from the displayed label in this
     *  selector — it's the global service picker, not the topology
     *  view, so per-topology `showGroup` doesn't apply here. */
    namingRule?: ServiceNamingRule | null;
    /** Layer's service-slot alias for the name column header (e.g.
     *  "ActiveMQ clusters", "Databases"). Falls back to the generic
     *  "Service" when the layer defines no alias. */
    serviceLabel?: string;
  }>(),
  {
    accent: 'var(--sw-accent)',
    pageSize: 8,
    namingRule: null,
  },
);
function identity(name: string | null | undefined) {
  return resolveServiceIdentity(name, props.namingRule);
}
const emit = defineEmits<{ (e: 'select', id: string): void }>();

const filter = ref('');
const page = ref(0);

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (q.length === 0) return props.services;
  return props.services.filter((s) => s.serviceName.toLowerCase().includes(q));
});
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / props.pageSize)));
const currentPage = computed(() => Math.min(page.value, pageCount.value - 1));
const visible = computed(() => {
  const start = currentPage.value * props.pageSize;
  return filtered.value.slice(start, start + props.pageSize);
});
watch(filter, () => (page.value = 0));

function colorForStatus(s: 'ok' | 'warn' | 'err'): string {
  return s === 'err' ? 'var(--sw-err)' : s === 'warn' ? 'var(--sw-warn)' : 'var(--sw-ok)';
}
</script>

<template>
  <section class="sw-card picker">
    <header class="picker-head">
      <input
        v-model="filter"
        class="search"
        :placeholder="t('filter by name…')"
        spellcheck="false"
        autocomplete="off"
      />
      <span class="count">{{ t('{n} of {total}', { n: filtered.length, total: services.length }) }}</span>
    </header>
    <table class="sw-table picker-table">
      <thead>
        <tr>
          <th class="svc-col">{{ serviceLabel || t('Service') }}</th>
          <th
            v-for="c in columns"
            :key="c.metric"
            class="num"
            :title="`${metricMeta(c.metric).longLabel}\n\n${metricMeta(c.metric).tip}`"
          >
            {{ c.label }}<span v-if="c.unit" class="unit">{{ c.unit }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in visible"
          :key="row.serviceId"
          class="row"
          :class="{ active: row.serviceId === selectedId }"
          @click="emit('select', row.serviceId)"
        >
          <td class="svc-col" :title="row.serviceName">
            <span class="pulse" :style="{ background: colorForStatus(statusForMetrics(row.metrics)) }" />
            <span v-if="identity(row.serviceName).cluster" class="group-chip">
              <span class="chip-alias">{{ identity(row.serviceName).clusterAlias }}</span>
              <span class="chip-val">{{ identity(row.serviceName).cluster }}</span>
            </span>
            <span class="name-text">{{ row.shortName || identity(row.serviceName).display }}</span>
          </td>
          <td
            v-for="c in columns"
            :key="c.metric"
            class="num"
            :class="{ muted: row.metrics[c.metric] == null }"
            :style="{ color: thresholdColor(c.metric, row.metrics[c.metric] ?? null) ?? undefined }"
          >
            {{ fmtMetric(row.metrics[c.metric]) }}
          </td>
        </tr>
        <tr v-if="visible.length === 0">
          <td :colspan="columns.length + 1" class="empty">
            {{ t('No services match') }} <code>{{ filter }}</code>.
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="pageCount > 1" class="pager">
      <button class="sw-btn ghost small" :disabled="currentPage === 0" @click="page = currentPage - 1">←</button>
      <span class="page-info">{{ currentPage + 1 }} / {{ pageCount }}</span>
      <button
        class="sw-btn ghost small"
        :disabled="currentPage >= pageCount - 1"
        @click="page = currentPage + 1"
      >→</button>
    </div>
  </section>
</template>

<style scoped>
.picker {
  margin-bottom: 14px;
}
.picker-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
}
.search {
  flex: 1;
  max-width: 320px;
  height: 28px;
  padding: 0 10px;
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 12px;
}
.search:focus {
  outline: 1px solid var(--sw-accent-line);
  border-color: var(--sw-accent-line);
}
.count {
  font-size: 11px;
  color: var(--sw-fg-3);
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
.picker-table {
  width: 100%;
  font-size: 11.5px;
}
.picker-table th {
  text-align: left;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
  font-weight: 500;
  padding: 6px 12px;
  border-bottom: 1px solid var(--sw-line);
}
.picker-table th.num {
  text-align: right;
}
.picker-table td {
  padding: 7px 12px;
  color: var(--sw-fg-1);
  border-bottom: 1px solid var(--sw-line);
}
.picker-table td.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.picker-table td.muted {
  color: var(--sw-fg-3);
}
.picker-table tr.row {
  cursor: pointer;
}
.picker-table tr.row:hover {
  background: var(--sw-bg-2);
}
.picker-table tr.row.active {
  background: var(--sw-accent-soft);
  box-shadow: inset 3px 0 0 var(--sw-accent);
}
.picker-table tr.row.active td {
  /* Lift the inner border so the highlight reads as one block. */
  border-bottom-color: var(--sw-accent-line);
}
.picker-table tr.row.active .name-text {
  color: var(--sw-accent-2);
  font-weight: 700;
}
.picker-table tr.row.active .pulse {
  box-shadow: 0 0 0 3px rgba(249, 115, 22, 0.18);
}
.picker-table .empty {
  text-align: center;
  padding: 18px;
  color: var(--sw-fg-3);
  font-size: 11px;
}
.picker-table .empty code {
  font-family: var(--sw-mono);
  background: var(--sw-bg-2);
  padding: 1px 4px;
  border-radius: 3px;
}
.svc-col {
  max-width: 280px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pulse {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-right: 8px;
  vertical-align: middle;
  box-shadow: 0 0 0 0 currentColor;
}
.name-text {
  font-family: var(--sw-mono);
  color: var(--sw-fg-0);
  font-size: 11.5px;
}
/* Group prefix from OAP's `<group>::<base>` naming — surfaced as a
   compact tag so the base name is the first thing the eye lands on.
   Trims `agent::rating` → [agent] rating, etc. */
.group-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
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
.group-chip .chip-alias { opacity: 0.7; font-weight: 500; }
.group-chip .chip-alias::after { content: '·'; margin: 0 2px; }
.group-chip .chip-val { font-family: var(--sw-mono); text-transform: none; letter-spacing: 0; }
.row.active .group-chip {
  color: var(--sw-accent-2);
  border-color: var(--sw-accent-line);
}
.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 8px 0 12px;
}
.pager .sw-btn {
  height: 22px;
  font-size: 11px;
  padding: 0 8px;
}
.pager .sw-btn[disabled] {
  opacity: 0.4;
  cursor: not-allowed;
}
.page-info {
  font-size: 10.5px;
  color: var(--sw-fg-2);
  font-variant-numeric: tabular-nums;
}
</style>
