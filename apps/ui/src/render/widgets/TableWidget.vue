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
  `table` dashboard widget: a labeled latest(...) metric rendered as a
  scrollable name→value table. Each row is one label combination
  (status / phase / condition / entity dimension). The value column is
  optional (showValues=false renders a presence list, e.g. node
  conditions whose value is always 1).

  Multi-entity compare: when `entities` (>=2) is supplied, rows carry an
  `entityKey` (tagged client-side) and a prepended Entity column groups
  them; per entity the first `labelTopN` rows show and the rest fold into
  one `(others)` row — summed for count-like formats, count-only for
  non-additive ones (a sum of percentiles / latencies would be wrong).
-->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DashboardTableRow } from '@skywalking-horizon-ui/api-client';
import { fmtMetricAs } from '@/utils/formatters';

const { t } = useI18n({ useScope: 'global' });

interface CompareEntity {
  key: string;
  name: string;
  hue: string;
}
type Row = DashboardTableRow & { entityKey?: string };

const props = withDefaults(
  defineProps<{
    rows: Row[];
    /** Optional value-column header; the label columns are headed by
     *  their dimension key. `[, valueHeader]` — first entry unused. */
    headers?: [string, string];
    showValues?: boolean;
    unit?: string;
    format?: 'int' | 'decimal' | 'compact' | 'duration' | 'enum';
    /** Multi-entity compare cohort. When >=2, prepend an Entity column
     *  and group rows by entity (in this order). */
    entities?: ReadonlyArray<CompareEntity>;
    /** Per-entity label-row cap before folding into `(others)`. */
    labelTopN?: number;
  }>(),
  { showValues: true, labelTopN: 8 },
);

const entityList = computed<ReadonlyArray<CompareEntity>>(() => props.entities ?? []);
const multiEntity = computed(() => entityList.value.length >= 2);

const labelKeys = computed<string[]>(() => {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const r of props.rows) {
    for (const l of r.labels) {
      if (!seen.has(l.key)) {
        seen.add(l.key);
        keys.push(l.key);
      }
    }
  }
  return keys;
});

interface DisplayRow {
  entityKey?: string;
  bandStart: boolean;
  labels: Array<{ key: string; value: string }>;
  value: number | null;
  others: number; // 0 = a normal row; >0 = an "(others)" fold of N rows
}

const displayRows = computed<DisplayRow[]>(() => {
  if (!multiEntity.value) {
    return props.rows.map((r) => ({
      entityKey: undefined,
      bandStart: false,
      labels: r.labels,
      value: r.value,
      others: 0,
    }));
  }
  // A sum is only meaningful for count-like metrics; everything else
  // (latency / percentile / sla / enum) folds to a count, value null.
  const additive = props.format === 'int' || props.format === 'compact';
  const out: DisplayRow[] = [];
  for (const ent of entityList.value) {
    const rows = props.rows.filter((r) => r.entityKey === ent.key);
    const head = rows.slice(0, props.labelTopN);
    head.forEach((r, i) =>
      out.push({ entityKey: ent.key, bandStart: i === 0, labels: r.labels, value: r.value, others: 0 }),
    );
    const tail = rows.slice(props.labelTopN);
    if (tail.length > 0) {
      out.push({
        entityKey: ent.key,
        bandStart: head.length === 0,
        labels: [],
        value: additive ? tail.reduce((a, r) => a + (r.value ?? 0), 0) : null,
        others: tail.length,
      });
    }
  }
  return out;
});

function entityFor(key?: string): CompareEntity | undefined {
  return entityList.value.find((e) => e.key === key);
}
function titleCase(k: string): string {
  return k.replace(/[_.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
const valueHeader = computed(() => props.headers?.[1] || 'Value');
function cell(r: DisplayRow, key: string): string {
  return r.labels.find((l) => l.key === key)?.value ?? '—';
}
function fmt(v: number | null): string {
  if (v === null || v === undefined) return '—';
  const s = fmtMetricAs(v, props.format);
  return props.unit ? `${s} ${props.unit}` : s;
}
</script>

<template>
  <div class="tw">
    <table class="tw__table">
      <thead>
        <tr>
          <th v-if="multiEntity" class="tw__entity-col">{{ t('Entity') }}</th>
          <th v-for="k in labelKeys" :key="k">{{ titleCase(k) }}</th>
          <th v-if="showValues" class="tw__num">{{ valueHeader }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(r, i) in displayRows" :key="i" :class="{ 'tw__band-start': multiEntity && r.bandStart }">
          <td v-if="multiEntity" class="tw__entity-col mono">
            <template v-if="r.bandStart">
              <span class="tw__dot" :style="{ background: entityFor(r.entityKey)?.hue }" />
              {{ entityFor(r.entityKey)?.name ?? r.entityKey }}
            </template>
          </td>
          <template v-if="r.others > 0">
            <td class="tw__cell mono others">(others) · +{{ r.others }}</td>
            <td v-for="k in labelKeys.slice(1)" :key="k" class="tw__cell mono">—</td>
          </template>
          <template v-else>
            <td v-for="k in labelKeys" :key="k" class="tw__cell mono" :title="cell(r, k)">{{ cell(r, k) }}</td>
          </template>
          <td v-if="showValues" class="tw__num mono">{{ fmt(r.value) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.tw { height: 100%; overflow: auto; }
.tw__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11.5px;
}
.tw__table th {
  position: sticky;
  top: 0;
  text-align: left;
  font-weight: 600;
  color: var(--sw-fg-2);
  background: var(--sw-bg-1);
  padding: 4px 8px;
  border-bottom: 1px solid var(--sw-line);
  white-space: nowrap;
}
.tw__table th.tw__num { text-align: right; }
.tw__table td {
  padding: 3px 8px;
  border-bottom: 1px solid var(--sw-line-2, var(--sw-line));
  color: var(--sw-fg-1);
}
.tw__cell {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tw__num { text-align: right; white-space: nowrap; color: var(--sw-fg-0); width: 1%; }
.tw__table tbody tr:hover td { background: var(--sw-bg-2); }
.tw__entity-col {
  white-space: nowrap;
  color: var(--sw-fg-0);
  font-weight: 600;
}
.tw__band-start td { border-top: 1px solid var(--sw-line); }
.tw__dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
  vertical-align: middle;
}
.others { color: var(--sw-fg-3); font-style: italic; }
.mono { font-family: var(--sw-mono); }
</style>
