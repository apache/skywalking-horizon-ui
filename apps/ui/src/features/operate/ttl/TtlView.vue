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
<script setup lang="ts">
import { computed } from 'vue';
import { useTtl } from './useTtl';

// Read-only data-retention view. OAP reports TTL in whole DAYS, split by
// hot/warm (the plain field) and cold (`cold*`). A cold value of -1 means
// the backend has no cold stage configured, rendered as "no cold stage".

const { reachable, records, metrics, data, isLoading, refetch } = useTtl();

interface Row {
  label: string;
  hot: number | undefined;
  cold?: number | undefined;
  /** metadata has no cold counterpart. */
  hasCold: boolean;
}

const recordRows = computed<Row[]>(() => {
  const r = records.value;
  if (!r) return [];
  return [
    { label: 'Normal', hot: r.normal, cold: r.coldNormal, hasCold: true },
    { label: 'Trace', hot: r.trace, cold: r.coldTrace, hasCold: true },
    { label: 'Zipkin trace', hot: r.zipkinTrace, cold: r.coldZipkinTrace, hasCold: true },
    { label: 'Log', hot: r.log, cold: r.coldLog, hasCold: true },
    { label: 'Browser error log', hot: r.browserErrorLog, cold: r.coldBrowserErrorLog, hasCold: true },
  ];
});

const metricRows = computed<Row[]>(() => {
  const m = metrics.value;
  if (!m) return [];
  return [
    // `metadata` isn't exposed by every OAP deployment; omit when absent.
    ...(m.metadata !== undefined ? [{ label: 'Metadata', hot: m.metadata, hasCold: false }] : []),
    { label: 'Minute', hot: m.minute, cold: m.coldMinute, hasCold: true },
    { label: 'Hour', hot: m.hour, cold: m.coldHour, hasCold: true },
    { label: 'Day', hot: m.day, cold: m.coldDay, hasCold: true },
  ];
});

function days(n: number | undefined): string {
  return n === undefined ? '—' : `${n} d`;
}
function coldLabel(r: Row): string {
  if (!r.hasCold) return 'no cold stage';
  if (r.cold === undefined) return '—';
  return r.cold < 0 ? 'no cold stage' : `cold: ${r.cold} d`;
}
</script>

<template>
  <div class="ttl">
    <header class="page-head">
      <div>
        <div class="kicker">Operate · Data retention</div>
        <h1>Time To Live</h1>
        <p class="lede">
          How long the connected OAP keeps each class of data, reported in whole days.
          <strong>Records</strong> cover event-style data (traces, logs);
          <strong>metrics</strong> cover the aggregated tiers (minute / hour / day) plus metadata.
          The <code>cold</code> value is the cold-stage retention (BanyanDB) — <em>no cold stage</em>
          means cold storage isn't configured. Read-only; change retention on the OAP side.
        </p>
      </div>
      <button type="button" class="refresh" @click="refetch()">refresh</button>
    </header>

    <div v-if="!reachable && data?.error" class="last-error block">
      <strong>OAP unreachable</strong>
      <code>{{ data.error }}</code>
      <p class="hint">
        TTL is read from the query / GraphQL port via <code>getRecordsTTL</code> /
        <code>getMetricsTTL</code>. Confirm <code>oap.queryUrl</code> points at a live OAP.
      </p>
    </div>

    <div v-else-if="isLoading && !data" class="empty">Reading data…</div>

    <template v-else>
      <section class="pane">
        <header class="pane-head"><h2>Records</h2></header>
        <div class="grid">
          <div v-for="row in recordRows" :key="row.label" class="sw-card kpi">
            <div class="sw-card-head"><h4>{{ row.label }}</h4></div>
            <div class="kpi-body">
              <div class="kpi-value">{{ days(row.hot) }}</div>
              <div class="kpi-label" :class="{ none: row.hasCold && (row.cold ?? -1) < 0 }">
                {{ coldLabel(row) }}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="pane">
        <header class="pane-head"><h2>Metrics</h2></header>
        <div class="grid">
          <div v-for="row in metricRows" :key="row.label" class="sw-card kpi">
            <div class="sw-card-head"><h4>{{ row.label }}</h4></div>
            <div class="kpi-body">
              <div class="kpi-value">{{ days(row.hot) }}</div>
              <div class="kpi-label" :class="{ none: row.hasCold && (row.cold ?? -1) < 0 }">
                {{ coldLabel(row) }}
              </div>
            </div>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.ttl {
  padding: 20px 20px 60px;
  max-width: 1440px;
  margin: 0 auto;
}
.page-head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 22px;
}
.page-head > div {
  flex: 1;
}
.kicker {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sw-accent);
  margin-bottom: 6px;
}
.page-head h1 {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--sw-fg-0);
  margin: 0 0 8px;
}
.lede {
  font-size: 12.5px;
  color: var(--sw-fg-1);
  line-height: 1.5;
  margin: 0;
  max-width: 760px;
}
.lede code {
  font-family: var(--sw-mono);
  background: var(--sw-bg-1);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 11px;
}
.refresh {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-1);
  font-size: 11px;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.refresh:hover {
  background: var(--sw-bg-2);
  color: var(--sw-fg-0);
}

.pane {
  margin-bottom: 26px;
}
.pane-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.pane-head h2 {
  font-size: 13px;
  font-weight: 600;
  color: var(--sw-fg-0);
  margin: 0;
  letter-spacing: -0.01em;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}
.kpi .sw-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.kpi .sw-card-head h4 {
  flex: 1;
}
.kpi-body {
  padding: 14px 12px;
}
.kpi-value {
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.kpi-label {
  margin-top: 4px;
  font-size: 11px;
  color: var(--sw-fg-2);
  font-variant-numeric: tabular-nums;
}
.kpi-label.none {
  color: var(--sw-fg-3);
  font-style: italic;
}

.empty {
  padding: 14px;
  color: var(--sw-fg-3);
  font-size: 12px;
  background: var(--sw-bg-1);
  border: 1px dashed var(--sw-line-2);
  border-radius: 6px;
}

.last-error {
  margin-bottom: 22px;
  padding: 10px 12px;
  background: var(--sw-err-soft);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 6px;
  font-size: 11.5px;
  color: var(--sw-fg-1);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}
.last-error strong {
  color: var(--sw-err);
  font-weight: 600;
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.08em;
}
.last-error code {
  font-family: var(--sw-mono);
  font-size: 11.5px;
  color: var(--sw-fg-0);
  word-break: break-all;
}
.last-error .hint {
  margin: 6px 0 0;
  font-size: 11.5px;
  color: var(--sw-fg-1);
  line-height: 1.5;
}
.last-error .hint code {
  background: rgba(0, 0, 0, 0.25);
  padding: 1px 4px;
  border-radius: 3px;
}
</style>
