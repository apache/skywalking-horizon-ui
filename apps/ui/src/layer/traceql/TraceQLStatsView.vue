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
  Where a trace spent its time, rolled up per span name and service — the
  native statistics view's question, asked of OTLP spans. The error column
  counts spans whose OTLP status is `error`, and unset is not counted as
  either: it is a third state, not a quiet success.
-->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TraceQLSpan } from '@skywalking-horizon-ui/api-client';
import { buildServiceColors, fmtMs, kindLabel, otlpKindName, serviceColorFrom } from './traceqlDetailShared';

const props = defineProps<{ spans: TraceQLSpan[] }>();
const { t } = useI18n({ useScope: 'global' });
const colors = computed(() => buildServiceColors(props.spans));

interface StatRow {
  name: string;
  service: string;
  kind: string;
  count: number;
  errors: number;
  totalUs: number;
  avgUs: number;
  maxUs: number;
}

type SortKey = 'total' | 'avg' | 'max' | 'count';
const sortKey = ref<SortKey>('total');
const sortDir = ref<'asc' | 'desc'>('desc');
function toggleSort(key: SortKey): void {
  if (sortKey.value === key) sortDir.value = sortDir.value === 'desc' ? 'asc' : 'desc';
  else {
    sortKey.value = key;
    sortDir.value = 'desc';
  }
}

const rows = computed<StatRow[]>(() => {
  const acc = new Map<string, StatRow>();
  for (const s of props.spans) {
    const key = `${s.service}\u0000${s.name}\u0000${s.kind}`;
    const row = acc.get(key) ?? {
      name: s.name || '—',
      service: s.service,
      kind: s.kind,
      count: 0,
      errors: 0,
      totalUs: 0,
      avgUs: 0,
      maxUs: 0,
    };
    row.count += 1;
    if (s.status === 'error') row.errors += 1;
    row.totalUs += s.durationUs;
    row.maxUs = Math.max(row.maxUs, s.durationUs);
    acc.set(key, row);
  }
  const list = [...acc.values()].map((r) => ({ ...r, avgUs: r.count ? r.totalUs / r.count : 0 }));
  const field = { total: 'totalUs', avg: 'avgUs', max: 'maxUs', count: 'count' } as const;
  const f = field[sortKey.value];
  return list.sort((a, b) => (sortDir.value === 'desc' ? b[f] - a[f] : a[f] - b[f]));
});
</script>

<template>
  <div class="tqs-wrap">
    <table class="tqs-table">
      <thead>
        <tr>
          <th>{{ t('Span name') }}</th>
          <th>{{ t('Service') }}</th>
          <th>{{ t('Kind') }}</th>
          <th class="num" @click="toggleSort('count')">{{ t('COUNT') }}</th>
          <th class="num">{{ t('ERRORS') }}</th>
          <th class="num sortable" :class="{ on: sortKey === 'total' }" @click="toggleSort('total')">{{ t('TOTAL') }}</th>
          <th class="num sortable" :class="{ on: sortKey === 'avg' }" @click="toggleSort('avg')">{{ t('AVG') }}</th>
          <th class="num sortable" :class="{ on: sortKey === 'max' }" @click="toggleSort('max')">{{ t('MAX') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="`${r.service}/${r.name}/${r.kind}`">
          <td class="mono">{{ r.name }}</td>
          <td class="mono">
            <span class="dot" :style="{ background: serviceColorFrom(colors, r.service) }" />{{ r.service || '—' }}
          </td>
          <!-- The rows group on the OTLP kind, so two of them can both read
               Entry — a server call and a consumed message. The protocol's own
               word tells them apart. -->
          <td class="mono dim">{{ kindLabel(r.kind) }} <span class="raw">{{ otlpKindName(r.kind) }}</span></td>
          <td class="num mono">{{ r.count }}</td>
          <td class="num mono" :class="{ err: r.errors > 0 }">{{ r.errors || '—' }}</td>
          <td class="num mono">{{ fmtMs(r.totalUs) }}</td>
          <td class="num mono">{{ fmtMs(r.avgUs) }}</td>
          <td class="num mono">{{ fmtMs(r.maxUs) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.raw { color: var(--sw-fg-3); opacity: 0.75; font-size: 9.5px; }
.tqs-wrap { overflow: auto; max-height: 60vh; }
.tqs-table { width: 100%; border-collapse: collapse; font-size: 11px; }
th, td { text-align: left; padding: 5px 10px; border-bottom: 1px solid var(--sw-line-1); }
th {
  position: sticky;
  top: 0;
  background: var(--sw-bg-1);
  color: var(--sw-fg-3);
  font-size: 9.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  font-weight: 600;
}
th.sortable { cursor: pointer; }
th.on { color: var(--sw-accent); }
.num { text-align: right; }
.dim { color: var(--sw-fg-3); }
.err { color: var(--sw-err); }
.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; vertical-align: middle; }
.mono { font-family: var(--sw-mono); }
</style>
