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
  Renders an `ExpressionResult` per its `type`. The five MQE result types
  carry genuinely different value shapes — `values[].id` alone is a bucket
  timestamp, an entity name, a record's text, or nothing — so one generic
  table would misrepresent four of them.

  Everything shown comes from OAP verbatim; nothing here formats or rounds a
  value, because the question this answers is "what did the server actually
  return".
-->
<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ExpressionResult, MqeValues } from '@skywalking-horizon-ui/api-client';
import TimeChart from '@/components/charts/TimeChart.vue';
/** Loaded on demand: Monaco is a large dependency and this panel renders on
 *  every MQE row in the template editor, but the JSON view is opened rarely.
 *  A static import also drags the editor into any unit test that mounts a
 *  row, where it fails outright on jsdom's missing `queryCommandSupported`. */
const MonacoView = defineAsyncComponent(() => import('@/components/primitives/MonacoView.vue'));
import { alignSeries, seriesLabel } from './mqeSeries';
import { timestampLabel } from '@/utils/formatters';

const props = defineProps<{
  result: ExpressionResult;
  step: 'MINUTE' | 'HOUR' | 'DAY';
}>();

const { t } = useI18n({ useScope: 'global' });

/** Series name from the metric's labels, or a positional fallback. A result
 *  with no labels is the unlabelled single-series case. */
function seriesName(r: MqeValues): string {
  return seriesLabel(r, results.value, t('value'));
}

const results = computed(() => props.result.results ?? []);

/** The chart and the table are built from the SAME aligned rows, so the point
 *  under the cursor is the row beneath it. They differ in PRECISION only: the
 *  chart's tooltip rounds for legibility, while the table prints OAP's string
 *  verbatim — the table is where an exact value is read. */
const chart = computed(() => alignSeries(props.result, props.step, t('value')));

/** A series is read as a shape; everything else as rows. The JSON view is
 *  the escape hatch from both — it is OAP's reply, pretty-printed, for the
 *  exact digits and for the fields no rendering surfaces (owner ids, the
 *  raw string form of every value). */
const hasChart = computed(
  () => props.result.type === 'TIME_SERIES_VALUES' && chart.value.ids.length > 0,
);
const view = ref<'render' | 'json'>('render');
const renderTabLabel = computed(() => (hasChart.value ? t('Graph') : t('Table')));
const pretty = computed(() => JSON.stringify(props.result, null, 2));

const copied = ref(false);
async function copyJson(): Promise<void> {
  try {
    await navigator.clipboard.writeText(pretty.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1200);
  } catch {
    /* clipboard blocked (insecure context / no permission) — no-op */
  }
}

/** A type can be legitimate while `results` is empty: when storage returns a
 *  series whose length disagrees with the duration's bucket count, OAP logs
 *  and returns early, leaving the type set and the array empty. That is "no
 *  rows", not an error, and must not render as one. */
const isEmpty = computed(() => {
  if (props.result.type === 'UNKNOWN') return false;
  if (results.value.length === 0) return true;
  // A TIME_SERIES result can come back with result rows whose values carry no
  // usable bucket id — there is then no axis to draw and no row to print, and
  // an unguarded chart would render a blank 200px frame over an empty table.
  if (props.result.type === 'TIME_SERIES_VALUES') return chart.value.ids.length === 0;
  if (props.result.type === 'SINGLE_VALUE') {
    return results.value.every((r) => (r.values?.length ?? 0) === 0);
  }
  return (results.value[0]?.values?.length ?? 0) === 0;
});

/* ── SINGLE_VALUE: one row per result; `id` is usually absent ── */
const singleRows = computed(() =>
  results.value.filter((r) => (r.values?.length ?? 0) > 0).map((r) => ({
    name: seriesName(r),
    value: r.values?.[0]?.value ?? null,
    /* Present for max/min/latest — it names the bucket that WON, which is
       the whole reason those differ from avg/count/sum. OAP sends it as
       epoch ms; a raw 13-digit number is not a time anyone reads. */
    at: bucketTime(r.values?.[0]?.id ?? null),
  })),
);

/* ── SORTED_LIST / RECORD_LIST: one flat list under a single result ── */
const listRows = computed(() => results.value[0]?.values ?? []);

/** An MQE bucket id is epoch ms. Anything non-numeric is passed through —
 *  only TIME_SERIES and the select-style aggregates carry a timestamp here. */
function bucketTime(id: string | null | undefined): string | null {
  if (!id) return null;
  const ms = Number(id);
  return Number.isFinite(ms) ? timestampLabel(ms) : id;
}

function ownerOf(v: { owner?: { serviceName?: string | null; serviceInstanceName?: string | null; endpointName?: string | null; scope?: string | null } | null }): string {
  const o = v.owner;
  if (!o) return '';
  return [o.endpointName, o.serviceInstanceName, o.serviceName].filter(Boolean).join(' · ');
}
</script>

<template>
  <div class="mrv">
    <!-- Only offered once there is something to show: an error or an empty
         result has no second representation worth switching to. -->
    <div v-if="!isEmpty && result.type !== 'UNKNOWN'" class="mrv-tabs" role="tablist">
      <button
        type="button"
        class="mrv-tab"
        :class="{ 'is-on': view === 'render' }"
        role="tab"
        :aria-selected="view === 'render'"
        @click="view = 'render'"
      >{{ renderTabLabel }}</button>
      <button
        type="button"
        class="mrv-tab"
        :class="{ 'is-on': view === 'json' }"
        role="tab"
        :aria-selected="view === 'json'"
        @click="view = 'json'"
      >{{ t('JSON') }}</button>
    </div>

    <div v-if="view === 'json' && !isEmpty && result.type !== 'UNKNOWN'" class="mrv-json">
      <div class="mrv-json-editor">
        <MonacoView :value="pretty" language="json" />
      </div>
      <div class="mrv-json-bar">
        <button type="button" class="mrv-copy" @click="copyJson">
          {{ copied ? t('Copied') : t('Copy JSON') }}
        </button>
      </div>
    </div>

    <template v-else-if="result.type === 'UNKNOWN'">
      <p class="mrv-err">{{ result.error || t('OAP could not resolve this expression.') }}</p>
    </template>

    <template v-else-if="isEmpty">
      <p class="mrv-empty">{{ t('No rows returned for this entity and time range.') }}</p>
    </template>

    <template v-else-if="result.type === 'TIME_SERIES_VALUES'">
      <!-- The graph IS the answer for a series — a 61-row value table beside
           it repeats what the line already shows. Exact numbers live one
           click away in Copy JSON, which hands over OAP's response verbatim. -->
      <div class="mrv-chart">
        <!-- Keyed on the axis itself: `TimeChart` watches `series` but not
             `xLabels`, so a re-run over a different window could otherwise
             slide new data under the old times. The key forces a remount
             whenever the axis changes, which no future edit can undo. -->
        <TimeChart
          :key="chart.ids[0] + ':' + chart.ids.length"
          :series="chart.series"
          :x-labels="chart.xLabels"
          :height="260"
        />
      </div>
      <p class="mrv-note">{{ t('{rows} buckets · {series} series', { rows: chart.ids.length, series: chart.series.length }) }}</p>
    </template>

    <template v-else-if="result.type === 'SINGLE_VALUE'">
      <div class="mrv-scroll">
        <table class="mrv-table">
          <thead>
            <tr>
              <th>{{ t('time') }}</th>
              <th>{{ t('labels') }}</th>
              <th class="num">{{ t('value') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, i) in singleRows" :key="i">
              <!-- Absent for avg/count/sum: those fold every bucket, so no
                   single one is the answer. Shown as an em-dash, not 0. -->
              <td class="mono dim">{{ row.at ?? '—' }}</td>
              <td class="mono">{{ row.name }}</td>
              <td class="num mono" :class="{ nil: row.value === null }">{{ row.value === null ? '—' : row.value }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <template v-else-if="result.type === 'SORTED_LIST'">
      <div class="mrv-scroll">
        <table class="mrv-table">
          <thead>
            <tr>
              <th class="rank">#</th>
              <th>{{ t('entity') }}</th>
              <th class="num">{{ t('value') }}</th>
              <th>{{ t('owner') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(v, i) in listRows" :key="i">
              <td class="rank mono dim">{{ i + 1 }}</td>
              <td class="mono">{{ v.id ?? '—' }}</td>
              <td class="num mono" :class="{ nil: v.value === null }">{{ v.value === null ? '—' : v.value }}</td>
              <td class="mono dim">{{ ownerOf(v) || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <template v-else-if="result.type === 'RECORD_LIST'">
      <div class="mrv-scroll">
        <table class="mrv-table">
          <thead>
            <tr>
              <th>{{ t('record') }}</th>
              <th class="num">{{ t('value') }}</th>
              <th>{{ t('trace id') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(v, i) in listRows" :key="i">
              <td class="mono wrap">{{ v.id ?? '—' }}</td>
              <td class="num mono" :class="{ nil: v.value === null }">{{ v.value === null ? '—' : v.value }}</td>
              <!-- An empty trace id is not a link: OAP sets `""` when the
                   sample has no associated trace. -->
              <td class="mono dim">{{ v.traceID || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.mrv { display: flex; flex-direction: column; gap: 6px; flex: 1; min-height: 0; }
.mrv-tabs { display: flex; gap: 2px; flex: 0 0 auto; }
.mrv-tab {
  padding: 3px 12px;
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--sw-fg-3);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
}
.mrv-tab:hover { color: var(--sw-fg-1); }
.mrv-tab.is-on {
  color: var(--sw-accent);
  background: var(--sw-accent-soft);
  border-color: var(--sw-accent-line);
}
/* Monaco sizes to its host, so the host needs a definite height inside the
   modal's flex column — `auto` collapses it to nothing. */
.mrv-json { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 4px; }
/* The editor takes the height; the action sits under it, left-aligned with
   the gutter so it reads as belonging to the document above it. */
.mrv-json-editor { flex: 1; min-height: 0; display: flex; }
.mrv-json-editor > * { flex: 1; min-height: 0; }
.mrv-json-bar { flex: 0 0 auto; display: flex; justify-content: flex-start; }
.mrv-copy {
  padding: 2px 10px;
  font-size: 11px;
  color: var(--sw-fg-2);
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  cursor: pointer;
}
.mrv-copy:hover { color: var(--sw-fg-0); border-color: var(--sw-accent-line); }
/* The chart keeps a definite height of its own — inside the modal's flex
   column an `auto` height would collapse to zero and render nothing. */
.mrv-chart {
  flex: 0 0 auto;
  border: 1px solid var(--sw-line);
  border-radius: 4px;
  background: var(--sw-bg-1);
  padding: 4px 6px 0;
}
.mrv-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; border: 1px solid var(--sw-line); border-radius: 4px; }
.mrv-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.mrv-table th,
.mrv-table td {
  text-align: left;
  padding: 4px 8px;
  border-bottom: 1px solid var(--sw-line);
  vertical-align: top;
}
.mrv-table thead th {
  position: sticky;
  top: 0;
  background: var(--sw-bg-3);
  color: var(--sw-fg-2);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  font-weight: 600;
  white-space: nowrap;
}
.mrv-table tbody tr:last-child td { border-bottom: none; }
.mrv-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.mrv-table .rank { width: 34px; text-align: right; }
.mrv-table .wrap { white-space: pre-wrap; word-break: break-word; max-width: 520px; }
.mono { font-family: var(--sw-mono); }
.dim { color: var(--sw-fg-3); }
.nil { color: var(--sw-fg-3); }
.mrv-note { margin: 0; font-size: 11px; color: var(--sw-fg-3); }
.mrv-empty { margin: 0; font-size: 12px; color: var(--sw-fg-2); }
.mrv-err {
  margin: 0;
  padding: 8px 10px;
  font-family: var(--sw-mono);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--sw-err);
  background: var(--sw-err-soft);
  border: 1px solid var(--sw-err);
  border-radius: 4px;
}
</style>
