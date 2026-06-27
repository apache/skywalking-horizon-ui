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
  Statistics view of the trace-detail card — per-span-name roll-up,
  grouped by SPAN NAME (endpointName when set, else component/peer) +
  service, sortable on Total / Avg / Max. Components aggregated per
  group; top-3 icons render in a single cell.
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { NativeSpan } from '@/api/client';
import { componentIconOrNull } from '@/layer/service-map/useTopologyIcons';
import { buildServiceColors, serviceColorFrom, fmtMs } from './traceDetailShared';

const { t } = useI18n({ useScope: 'global' });

const props = defineProps<{ spans: NativeSpan[] }>();

const serviceColors = computed(() => buildServiceColors(props.spans));
function serviceColor(c: string): string { return serviceColorFrom(serviceColors.value, c); }

type StatSortKey = 'total' | 'avg' | 'max';
const statSortKey = ref<StatSortKey>('total');
const statSortDir = ref<'asc' | 'desc'>('desc');
function toggleStatSort(key: StatSortKey): void {
  if (statSortKey.value === key) {
    statSortDir.value = statSortDir.value === 'desc' ? 'asc' : 'desc';
  } else {
    statSortKey.value = key;
    statSortDir.value = 'desc';
  }
}

interface StatRow {
  name: string;
  service: string;
  count: number;
  total: number;
  avg: number;
  max: number;
  components: Array<{ name: string; count: number }>;
}
function spanGroupName(s: NativeSpan): string {
  return s.endpointName || s.component || s.peer || '—';
}
const nativeStats = computed<StatRow[]>(() => {
  const spans = props.spans;
  const groups = new Map<string, {
    service: string;
    name: string;
    durations: number[];
    componentCounts: Map<string, number>;
  }>();
  for (const s of spans) {
    const name = spanGroupName(s);
    const k = `${s.serviceCode}/${name}`;
    const g = groups.get(k) ?? {
      service: s.serviceCode,
      name,
      durations: [],
      componentCounts: new Map<string, number>(),
    };
    g.durations.push(Math.max(0, s.endTime - s.startTime));
    if (s.component) {
      g.componentCounts.set(s.component, (g.componentCounts.get(s.component) ?? 0) + 1);
    }
    groups.set(k, g);
  }
  const rows: StatRow[] = Array.from(groups.values()).map((g) => {
    const total = g.durations.reduce((a, b) => a + b, 0);
    const components = Array.from(g.componentCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
    return {
      service: g.service,
      name: g.name,
      count: g.durations.length,
      total,
      avg: total / g.durations.length,
      max: Math.max(...g.durations),
      components,
    };
  });
  const k = statSortKey.value;
  const dir = statSortDir.value === 'asc' ? 1 : -1;
  rows.sort((a, b) => (a[k] - b[k]) * dir);
  return rows;
});
</script>

<template>
  <div v-if="nativeStats.length === 0" class="tr-empty">{{ t('no span data') }}</div>
  <table v-else class="tr-table">
    <thead>
      <tr>
        <th class="endpoint-col">{{ t('Span name') }}</th>
        <th>{{ t('Service') }}</th>
        <th>{{ t('Components') }}</th>
        <th class="num">{{ t('Count') }}</th>
        <th
          class="num sortable"
          :class="{ on: statSortKey === 'total' }"
          @click="toggleStatSort('total')"
        >
          {{ t('Total') }}
          <span class="sort-ind">{{ statSortKey === 'total' ? (statSortDir === 'desc' ? '↓' : '↑') : '↕' }}</span>
        </th>
        <th
          class="num sortable"
          :class="{ on: statSortKey === 'avg' }"
          @click="toggleStatSort('avg')"
        >
          {{ t('Avg') }}
          <span class="sort-ind">{{ statSortKey === 'avg' ? (statSortDir === 'desc' ? '↓' : '↑') : '↕' }}</span>
        </th>
        <th
          class="num sortable"
          :class="{ on: statSortKey === 'max' }"
          @click="toggleStatSort('max')"
        >
          {{ t('Max') }}
          <span class="sort-ind">{{ statSortKey === 'max' ? (statSortDir === 'desc' ? '↓' : '↑') : '↕' }}</span>
        </th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="(r, i) in nativeStats" :key="i">
        <td class="mono endpoint-col" :title="r.name">{{ r.name }}</td>
        <td class="mono" :style="{ color: serviceColor(r.service) }" :title="r.service">
          <span class="svc-swatch inline" :style="{ background: serviceColor(r.service) }" />
          {{ r.service }}
        </td>
        <td>
          <span v-if="r.components.length === 0" class="dim">—</span>
          <span v-else class="stat-comp-stack">
            <span
              v-for="(c, ci) in r.components"
              :key="ci"
              class="stat-comp"
              :title="t('{name} · {count}', { name: c.name, count: c.count })"
            >
              <img
                v-if="componentIconOrNull(c.name)"
                class="comp-icon"
                :src="componentIconOrNull(c.name) ?? ''"
                :alt="c.name"
              />
              <svg v-else class="comp-icon comp-icon-generic" viewBox="0 0 18 18">
                <rect x="3" y="4.5" width="12" height="3" rx="1.5" fill="currentColor" opacity="0.45" />
                <rect x="5" y="10.5" width="10" height="3" rx="1.5" fill="currentColor" opacity="0.85" />
              </svg>
              <span class="mono dim">×{{ c.count }}</span>
            </span>
          </span>
        </td>
        <td class="num mono">{{ r.count }}</td>
        <td class="num mono">{{ fmtMs(r.total) }}</td>
        <td class="num mono">{{ fmtMs(r.avg) }}</td>
        <td class="num mono">{{ fmtMs(r.max) }}</td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
.tr-empty { padding: 24px; text-align: center; color: var(--sw-fg-3); font-size: 11.5px; }
.mono { font-family: var(--sw-mono); }
.dim { color: var(--sw-fg-3); }

.svc-swatch {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex: 0 0 auto;
}
.svc-swatch.inline {
  display: inline-block;
  margin-right: 4px;
  vertical-align: middle;
}

/* Technology component icon — same PNG set as the topology map. */
.comp-icon {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  object-fit: contain;
  background: transparent;
}
.comp-icon-generic { color: var(--sw-fg-2); }

/* Table */
.tr-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11.5px;
}
.tr-table th {
  text-align: left;
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-fg-3);
  font-weight: 600;
  padding: 6px 12px;
  border-bottom: 1px solid var(--sw-line);
}
.tr-table th.num { text-align: right; }
.tr-table th.endpoint-col { width: 40%; }
.tr-table td {
  padding: 6px 12px;
  border-bottom: 1px solid var(--sw-line);
  max-width: 1px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tr-table td.endpoint-col { max-width: none; }
.tr-table td.num { text-align: right; }
.tr-table td.mono { font-family: var(--sw-mono); }
.tr-table td.dim { color: var(--sw-fg-3); }
.tr-table tbody tr { cursor: pointer; }
.tr-table tbody tr:hover { background: var(--sw-bg-2); }
.tr-table tbody tr.err { background: rgba(239, 68, 68, 0.06); }
/* Statistics — components column. */
.stat-comp-stack {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-wrap: nowrap;
}
.stat-comp {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10.5px;
}
.stat-comp .comp-icon { width: 16px; height: 16px; }

.tr-table th.sortable {
  cursor: pointer;
  user-select: none;
}
.tr-table th.sortable:hover { color: var(--sw-fg-1); }
.tr-table th.sortable.on { color: var(--sw-accent); }
.sort-ind {
  display: inline-block;
  margin-left: 4px;
  font-family: var(--sw-mono);
  font-size: 10px;
  opacity: 0.7;
}
.tr-table th.sortable.on .sort-ind { opacity: 1; }
</style>
