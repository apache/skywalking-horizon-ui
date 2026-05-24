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
  Read-only data-retention view.

  Render branches on the storage backend the BFF probes (BanyanDB vs
  other). For BanyanDB the page renders TWO stages — HOT+WARM (queried
  by default) and COLD (opt-in via the topbar cold-stage chip). For
  any other backend it renders a single uniform stage; the cold pane
  is hidden because OAP doesn't surface cold data there.

  OAP does NOT expose the hot-vs-warm split on the wire — the value
  shown for "hot + warm" is the sum the OAP-side resolver already
  computed. Don't try to derive a warm-only number here; if the
  operator wants the breakdown they read the BanyanDB config.

  Cold semantics worth knowing (and surfacing to the operator):
  OAP's `Duration.coldStage: true` REPLACES the hot+warm read with a
  cold-only read — it doesn't union the two. Flipping the topbar Cold
  pill on while looking at a recent window makes every widget go
  empty, because cold doesn't hold recent data. The tip rendered
  below the lede when the toggle is on quotes the approximate cold
  window (derived from the trace TTL pair — most operator-relevant
  data class). Per-class boundaries differ slightly; this is a hint,
  not a hard guarantee (segment migration shifts boundaries; recent
  edits can briefly leave records in both stages).
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { TtlStageBreakdown } from '@skywalking-horizon-ui/api-client';
import { useTtl } from './useTtl';
import { useColdStageStore } from '@/controls/coldStage';

const { reachable, data, isLoading, refetch } = useTtl();
const cold = useColdStageStore();

const backend = computed(() => data.value?.backend ?? 'unknown');
const isBanyanDB = computed(() => backend.value === 'banyandb');
const stages = computed(() => data.value?.stages ?? null);
const hot = computed<TtlStageBreakdown | null>(() => stages.value?.hot ?? null);
const coldStage = computed<TtlStageBreakdown | null>(() => stages.value?.cold ?? null);

interface Row {
  label: string;
  days: number | undefined;
}

function recordsRows(s: TtlStageBreakdown): Row[] {
  return [
    { label: 'Normal',           days: s.records.normal },
    { label: 'Trace',            days: s.records.trace },
    { label: 'Zipkin trace',     days: s.records.zipkinTrace },
    { label: 'Log',              days: s.records.log },
    { label: 'Browser error log', days: s.records.browserErrorLog },
  ];
}
function metricsRows(s: TtlStageBreakdown): Row[] {
  return [
    ...(s.metrics.metadata !== undefined ? [{ label: 'Metadata', days: s.metrics.metadata }] : []),
    { label: 'Minute', days: s.metrics.minute },
    { label: 'Hour',   days: s.metrics.hour },
    { label: 'Day',    days: s.metrics.day },
  ];
}
function fmtDays(n: number | undefined): string {
  if (n === undefined) return '—';
  if (n < 0) return '—';
  return `${n} d`;
}

/** Cold-window tip when the toggle is on AND a cold stage is
 *  configured. Quotes the *approximate* cold window so the operator
 *  picks a time range that intersects it — otherwise the cold-only
 *  read returns nothing. Uses the trace TTL pair as the reference;
 *  other classes may differ slightly. */
const coldTip = computed<string | null>(() => {
  if (!cold.enabled) return null;
  if (!isBanyanDB.value) return null;
  if (!hot.value || !coldStage.value) return null;
  const hotTrace = hot.value.records.trace;
  const coldTrace = coldStage.value.records.trace;
  if (!Number.isFinite(hotTrace) || coldTrace < 0) return null;
  // Cold window for traces: data aged past the hot+warm tail
  // (hotTrace days back) and still within hot+warm+cold
  // (hotTrace + coldTrace days back).
  const start = hotTrace;
  const end = hotTrace + coldTrace;
  return (
    `Cold-only read is ACTIVE. OAP queries the cold stage INSTEAD of hot+warm — recent windows return empty. ` +
    `Pick a time range roughly ${start}–${end} days ago to see cold-stage traces; other data classes may have different boundaries — check the cards below.`
  );
});

const backendPillLabel = computed(() => {
  if (backend.value === 'banyandb') return 'BanyanDB';
  if (backend.value === 'other') return 'standard';
  return 'detecting…';
});

/** One bar per data class, grouped under Records / Metrics so the
 *  layout mirrors the cards below. Row widths are proportional to
 *  total retention across ALL rows — longest-lived class (often
 *  `metadata` or the cold-enabled metrics tiers) visibly stretches
 *  further right, so an operator can see at a glance which class
 *  outlives which. Classes with hotDays <= 0 (unknown / not
 *  exposed by the wire) drop out.
 *
 *  IMPORTANT — what's exposed: OAP's `getRecordsTTL` /
 *  `getMetricsTTL` collapse hot + warm into one number per class
 *  (see BanyanDBTTLStatusQuery in OAP). The "Hot + Warm" segment
 *  width here is that combined value, NOT the hot-only TTL. Don't
 *  try to split — the wire doesn't tell us. The footer note
 *  surfaces this so the operator isn't misled. */
interface LifecycleRow {
  label: string;
  hotDays: number;
  /** 0 when this class has no cold stage (any non-BanyanDB backend,
   *  or BanyanDB without a cold lifecycle stage configured). */
  coldDays: number;
  totalDays: number;
}

const lifecycleRecords = computed<LifecycleRow[]>(() => {
  const h = hot.value;
  if (!h) return [];
  const c = coldStage.value;
  const coldOr0 = (v: number | undefined): number => (v != null && v >= 0 ? v : 0);
  const rows: LifecycleRow[] = [
    { label: 'Normal',          hotDays: h.records.normal,          coldDays: coldOr0(c?.records.normal),          totalDays: 0 },
    { label: 'Trace',           hotDays: h.records.trace,           coldDays: coldOr0(c?.records.trace),           totalDays: 0 },
    { label: 'Zipkin trace',    hotDays: h.records.zipkinTrace,     coldDays: coldOr0(c?.records.zipkinTrace),     totalDays: 0 },
    { label: 'Log',             hotDays: h.records.log,             coldDays: coldOr0(c?.records.log),             totalDays: 0 },
    { label: 'Browser err log', hotDays: h.records.browserErrorLog, coldDays: coldOr0(c?.records.browserErrorLog), totalDays: 0 },
  ];
  return rows
    .filter((r) => Number.isFinite(r.hotDays) && r.hotDays > 0)
    .map((r) => ({ ...r, totalDays: r.hotDays + r.coldDays }));
});

const lifecycleMetrics = computed<LifecycleRow[]>(() => {
  const h = hot.value;
  if (!h) return [];
  const c = coldStage.value;
  const coldOr0 = (v: number | undefined): number => (v != null && v >= 0 ? v : 0);
  const rows: LifecycleRow[] = [
    // Metadata first — it has no cold tier and an independent (often
    // much longer) hot+warm. Putting it at the top of the Metrics
    // section avoids a tiny zero-cold row dropped between two larger
    // ones with cold.
    ...(h.metrics.metadata !== undefined
      ? [{ label: 'Metadata', hotDays: h.metrics.metadata, coldDays: 0, totalDays: h.metrics.metadata }]
      : []),
    { label: 'Minute metric', hotDays: h.metrics.minute, coldDays: coldOr0(c?.metrics.minute), totalDays: 0 },
    { label: 'Hour metric',   hotDays: h.metrics.hour,   coldDays: coldOr0(c?.metrics.hour),   totalDays: 0 },
    { label: 'Day metric',    hotDays: h.metrics.day,    coldDays: coldOr0(c?.metrics.day),    totalDays: 0 },
  ];
  return rows
    .filter((r) => Number.isFinite(r.hotDays) && r.hotDays > 0)
    .map((r) => ({ ...r, totalDays: r.totalDays || r.hotDays + r.coldDays }));
});

/** Collapse a per-class list into one row labelled "All <category>"
 *  when every class shares the exact same (hotDays, coldDays) pair.
 *  Non-BanyanDB always falls into this branch — OAP's default impl
 *  returns uniform values per category — so the operator sees a
 *  single honest summary instead of N identical bars. BanyanDB
 *  deployments with uniform per-class config get the same treatment
 *  naturally. When TTLs diverge, returns the per-class rows
 *  unchanged. */
function collapseUniform(rows: LifecycleRow[], categoryLabel: string): LifecycleRow[] {
  if (rows.length <= 1) return rows;
  const first = rows[0];
  const allMatch = rows.every((r) => r.hotDays === first.hotDays && r.coldDays === first.coldDays);
  if (!allMatch) return rows;
  return [
    {
      label: `All ${categoryLabel.toLowerCase()} (${rows.length})`,
      hotDays: first.hotDays,
      coldDays: first.coldDays,
      totalDays: first.totalDays,
    },
  ];
}
const lifecycleRecordsForRender = computed<LifecycleRow[]>(() =>
  collapseUniform(lifecycleRecords.value, 'Records'),
);
const lifecycleMetricsForRender = computed<LifecycleRow[]>(() =>
  collapseUniform(lifecycleMetrics.value, 'Metrics'),
);

/** Anchor for proportional row widths — single max across BOTH
 *  records and metrics so the visual comparison stays honest across
 *  sections (a 60-d metadata row should still tower over a 38-d
 *  trace row). At least 1 to avoid div-by-0 during initial load. */
const lifecycleMaxTotal = computed<number>(() => {
  const all = [...lifecycleRecordsForRender.value, ...lifecycleMetricsForRender.value];
  return Math.max(1, ...all.map((r) => r.totalDays));
});

</script>

<template>
  <div class="ttl">
    <header class="page-head">
      <div>
        <div class="kicker">Operate · Data retention</div>
        <h1>Time To Live</h1>
        <!-- The page splits sharply by backend: BanyanDB has a real
             multi-stage lifecycle (hot+warm + optional cold) so the
             lede explains the stages + the topbar Cold pill. When
             the BFF classifies the wire response as `other`, the
             TTL is a single flat retention per category and the
             stage vocabulary doesn't apply. -->
        <p v-if="isBanyanDB" class="lede">
          How long the connected OAP keeps each class of data, in whole days. Backend:
          <span class="backend-pill" :class="`is-${backend}`">{{ backendPillLabel }}</span>.
          BanyanDB ages data through configurable lifecycle stages — <strong>hot</strong>,
          optionally <strong>warm</strong>, optionally <strong>cold</strong>.
          <template v-if="coldStage">
            The topbar <em>Cold</em> pill swaps the read from <strong>hot + warm</strong> to
            <strong>cold</strong> — <em>it does not union the two</em>, so only enable it when
            the time range you're looking at is older than the hot+warm boundary.
          </template>
          <template v-else>
            This deployment has no cold lifecycle stage configured — only the hot + warm window
            is queryable.
          </template>
        </p>
        <p v-else class="lede">
          How long the connected OAP keeps each class of data, in whole days. Backend:
          <span class="backend-pill" :class="`is-${backend}`">{{ backendPillLabel }}</span>.
          This backend reports a single flat retention per category — no hot / warm / cold
          stages (those are BanyanDB-specific). Read-only; change retention on the OAP side.
        </p>
      </div>
      <button type="button" class="refresh" @click="refetch()">refresh</button>
    </header>

    <div v-if="!reachable && data?.error" class="last-error block">
      <strong>OAP unreachable</strong>
      <code>{{ data.error }}</code>
      <p class="hint">
        Couldn't reach the OAP query port. Confirm the OAP host is up and the configured
        query URL still resolves from this Horizon server.
      </p>
    </div>

    <div v-else-if="isLoading && !data" class="empty">Reading data…</div>

    <!-- ── Non-BanyanDB branch ───────────────────────────────────
         When the BFF classifies the wire response as `other`, the
         TTL is a single flat retention per category — no stages, no
         cold tier, no migration. Render just the TTL values; the
         lifecycle bar + Cold pane + cold tip are all suppressed
         because they'd describe a model the wire didn't surface. -->
    <template v-else-if="stages && !isBanyanDB">
      <section v-if="hot" class="pane">
        <header class="pane-head">
          <h2>Retention</h2>
          <span class="pane-sub">read-only · change on the OAP side</span>
        </header>
        <div class="sub-pane">
          <h3>Records</h3>
          <div class="grid">
            <div v-for="row in recordsRows(hot)" :key="`flat-r-${row.label}`" class="sw-card kpi">
              <div class="sw-card-head"><h4>{{ row.label }}</h4></div>
              <div class="kpi-body"><div class="kpi-value">{{ fmtDays(row.days) }}</div></div>
            </div>
          </div>
        </div>
        <div class="sub-pane">
          <h3>Metrics</h3>
          <div class="grid">
            <div v-for="row in metricsRows(hot)" :key="`flat-m-${row.label}`" class="sw-card kpi">
              <div class="sw-card-head"><h4>{{ row.label }}</h4></div>
              <div class="kpi-body"><div class="kpi-value">{{ fmtDays(row.days) }}</div></div>
            </div>
          </div>
        </div>
        <p class="flat-note">
          ⓘ Property data is omitted (forever-retained, no TTL reported).
        </p>
      </section>
    </template>

    <!-- ── BanyanDB branch ───────────────────────────────────────
         Full lifecycle layout: per-class timeline bar at the top,
         then Hot + Warm pane (queried by default), then Cold pane
         when configured. The cold-window tip appears only while
         the topbar Cold pill is on. -->
    <template v-else-if="stages">
      <!-- Per-data-class lifecycle. One bar per class so divergent
           TTLs are visible at a glance; widths are proportional to
           total retention across BOTH sections so a 60-d metadata
           row visibly towers over a 38-d trace row. Records and
           metrics are split into two sub-sections that mirror the
           cards below. -->
      <section
        v-if="lifecycleRecordsForRender.length > 0 || lifecycleMetricsForRender.length > 0"
        class="lifecycle"
      >
        <header class="lifecycle__head">
          <h2>Data lifecycle</h2>
          <span class="lifecycle__sub">Per-data-class · widths proportional to total retention</span>
        </header>

        <div v-if="lifecycleRecordsForRender.length > 0" class="lifecycle__group">
          <h3 class="lifecycle__group-h">Records</h3>
          <div v-for="r in lifecycleRecordsForRender" :key="`lc-rec-${r.label}`" class="lc-row">
            <div class="lc-row__label">{{ r.label }}</div>
            <div
              class="lc-row__bar"
              :style="{ width: `${(r.totalDays / lifecycleMaxTotal) * 100}%` }"
              :aria-label="`Hot + Warm ${r.hotDays} days${r.coldDays > 0 ? `, Cold ${r.coldDays} days` : ''}`"
            >
              <div class="lc-seg lc-seg--hot" :style="{ flex: r.hotDays }">
                <span class="lc-seg__name">Hot + Warm</span>
                <span class="lc-seg__days">{{ r.hotDays }} d</span>
              </div>
              <div v-if="r.coldDays > 0" class="lc-seg lc-seg--cold" :style="{ flex: r.coldDays }">
                <span class="lc-seg__name">Cold</span>
                <span class="lc-seg__days">{{ r.coldDays }} d</span>
              </div>
            </div>
            <div class="lc-row__total mono">{{ r.totalDays }} d total</div>
          </div>
        </div>

        <div v-if="lifecycleMetricsForRender.length > 0" class="lifecycle__group">
          <h3 class="lifecycle__group-h">Metrics</h3>
          <div v-for="r in lifecycleMetricsForRender" :key="`lc-met-${r.label}`" class="lc-row">
            <div class="lc-row__label">{{ r.label }}</div>
            <div
              class="lc-row__bar"
              :style="{ width: `${(r.totalDays / lifecycleMaxTotal) * 100}%` }"
              :aria-label="`Hot + Warm ${r.hotDays} days${r.coldDays > 0 ? `, Cold ${r.coldDays} days` : ''}`"
            >
              <div class="lc-seg lc-seg--hot" :style="{ flex: r.hotDays }">
                <span class="lc-seg__name">Hot + Warm</span>
                <span class="lc-seg__days">{{ r.hotDays }} d</span>
              </div>
              <div v-if="r.coldDays > 0" class="lc-seg lc-seg--cold" :style="{ flex: r.coldDays }">
                <span class="lc-seg__name">Cold</span>
                <span class="lc-seg__days">{{ r.coldDays }} d</span>
              </div>
            </div>
            <div class="lc-row__total mono">{{ r.totalDays }} d total</div>
          </div>
        </div>

        <p class="lifecycle__note">
          ⓘ OAP's TTL response collapses <em>hot</em> + <em>warm</em> into one combined value per
          class — the bar shows the queryable (hot + warm) window, not the per-stage breakdown.
          BanyanDB migrates between stages in <em>segments</em>, so a record near a boundary may
          briefly exist in both stages during the migration window. Property data is omitted
          (forever-retained, no TTL reported).
        </p>
      </section>

      <!-- Cold-only-read tip. Renders only while the topbar Cold
           pill is on AND a cold stage is configured — tells the
           operator which time window will actually return data. -->
      <div v-if="coldTip" class="cold-tip">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
          <path d="M12 3v18M3 12h18M5 5l14 14M19 5L5 19" />
          <path d="M9 6l3-3 3 3M15 18l-3 3-3-3M6 9L3 12l3 3M18 9l3 3-3 3" />
        </svg>
        <span>{{ coldTip }}</span>
      </div>
      <!-- The per-class Hot+Warm / Cold KPI-card panes that used to
           live here were redundant with the lifecycle bar above —
           every number in those cards is already shown on each
           bar's segment label and the right-side "X d total". -->
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
.backend-pill {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: 10px;
  font-family: var(--sw-mono);
  font-size: 10.5px;
  letter-spacing: 0.02em;
  border: 1px solid var(--sw-line-2);
  background: var(--sw-bg-1);
  color: var(--sw-fg-1);
}
.backend-pill.is-banyandb {
  color: var(--sw-accent);
  border-color: var(--sw-accent);
  background: var(--sw-accent-soft);
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

/* ── Lifecycle bar ──────────────────────────────────────────────
   At-a-glance horizontal timeline of ingest → deletion, segmented
   into Hot+Warm and (when configured) Cold. Segment widths are
   proportional to days so an operator's eye gets the ratio without
   reading the labels. Tick row beneath repeats the day numbers in
   the timeline's coordinate space; the note below names the
   migration-overlap caveat once instead of repeating it on the
   per-class cards. */
.lifecycle {
  margin-bottom: 22px;
}
.lifecycle__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
}
.lifecycle__head h2 {
  font-size: 13px;
  font-weight: 600;
  color: var(--sw-fg-0);
  margin: 0;
  letter-spacing: -0.01em;
}
.lifecycle__sub {
  font-size: 10.5px;
  color: var(--sw-fg-3);
  letter-spacing: 0.02em;
}
/* Per-group row: [class label] [bar (variable width)] [total]. The
 * label and total stay aligned across rows via the grid; only the
 * middle bar varies by class-group retention. */
.lc-row {
  display: grid;
  grid-template-columns: minmax(140px, 220px) 1fr auto;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}
.lc-row__label {
  font-size: 11.5px;
  color: var(--sw-fg-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lc-row__bar {
  display: flex;
  height: 28px;
  /* Each row's bar starts from the left edge of its column and
   * extends right by `width` (set inline, proportional to total
   * retention). A subtle dashed track behind shows the leftover
   * column space so an operator's eye reads "this class doesn't
   * reach the max-retention class's tail". */
  background:
    repeating-linear-gradient(
      to right,
      transparent 0 4px,
      var(--sw-line-2) 4px 5px
    );
  border-radius: 4px;
  overflow: hidden;
  min-width: 0;
  position: relative;
}
.lc-row__total {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--sw-fg-3);
  white-space: nowrap;
}
.lc-seg {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  min-width: 0;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lc-seg + .lc-seg {
  border-left: 1px solid var(--sw-line-2);
}
.lc-seg--hot {
  /* Hot+Warm reads as the "live" tier; use the accent's soft tint
     plus the accent color for text so the bar reads warmly on
     dark + light themes alike. */
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
}
.lc-seg--cold {
  /* Cold is opt-in; muted background + slate-ish text reads as
     archived without competing with the hot segment. */
  background: var(--sw-bg-2);
  color: var(--sw-fg-1);
}
.lc-seg__days {
  font-family: var(--sw-mono);
  font-variant-numeric: tabular-nums;
  opacity: 0.9;
}
.lifecycle__note {
  margin: 10px 0 0;
  padding: 8px 10px;
  background: var(--sw-bg-1);
  border: 1px dashed var(--sw-line-2);
  border-radius: 6px;
  font-size: 11.5px;
  color: var(--sw-fg-2);
  line-height: 1.55;
}
.lifecycle__note em {
  color: var(--sw-fg-0);
  font-style: normal;
  font-weight: 600;
}

/* Non-BanyanDB footer note — small reminder under the flat-
 * retention pane. Less prose than the BanyanDB one because there
 * are no stages or migrations to caveat. */
.flat-note {
  margin: 14px 0 0;
  font-size: 11.5px;
  color: var(--sw-fg-3);
  line-height: 1.5;
}

.cold-tip {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 18px;
  padding: 8px 12px;
  background: var(--sw-accent-soft);
  border: 1px solid var(--sw-accent);
  border-radius: 6px;
  color: var(--sw-accent);
  font-size: 11.5px;
  line-height: 1.5;
}

.pane {
  margin-bottom: 26px;
}
.pane.is-cold {
  /* Faint cool tint so the cold pane is visually distinct from
   * hot+warm without shouting. */
  border-left: 2px solid var(--sw-accent);
  padding-left: 12px;
}
.pane-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
}
.pane-head h2 {
  font-size: 14px;
  font-weight: 600;
  color: var(--sw-fg-0);
  margin: 0;
  letter-spacing: -0.01em;
}
.pane-sub {
  font-size: 10.5px;
  color: var(--sw-fg-3);
  letter-spacing: 0.02em;
}
.pane-sub strong {
  color: var(--sw-accent);
  font-weight: 600;
}

.sub-pane {
  margin: 6px 0 16px;
}
.sub-pane h3 {
  font-size: 11px;
  font-weight: 600;
  color: var(--sw-fg-2);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin: 0 0 6px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
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
  padding: 12px 10px;
}
.kpi-value {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--sw-fg-0);
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
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
