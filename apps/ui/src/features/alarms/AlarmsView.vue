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
  Alarms triage page. Layout:

   ┌── header ─────────────────────────────────────────────────────┐
   │ Alarms                       [20m] [2h] [4h] [custom] [↻]    │
   ├── KPI strip ──────────────────────────────────────────────────┤
   │  TOTAL · GENERAL · MESH · …pinned…  · k8s 4  vm 2  …overflow │
   ├── filter row (conditional on capabilities.queryAlarms) ──────┤
   │  layer · service · instance · endpoint · keyword · [apply]   │
   ├── timeline (alarm flags per layer lane) ─────────────────────┤
   │  click flag = select alarm; brush = select time range        │
   ├── grouped list ─────────────────────┬── detail panel ────────┤
   │  rows + frontend pager              │ expression + snapshot   │
   └─────────────────────────────────────┴────────────────────────┘

  Dual-mode contract — driven by `useOapInfo().capabilities.queryAlarms`:
   - New: filter row shows layer + cascade + keyword. Filters apply
          server-side via queryAlarms `entities` / `layers`.
   - Legacy: filter row shows keyword only. Server-side filters
          gracefully no-op; chips in the header still filter the
          fetched response client-side.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import {
  bff,
  type AlarmMessage,
  type AlarmsConfig,
  type AlarmsResponse,
} from '@/api/client';
import { useOapInfo } from '@/shell/useOapInfo';
import AlarmsTimeline from '@/components/charts/AlarmsTimeline.vue';
import AlarmDetailPanel from './AlarmDetailPanel.vue';
import AlarmWindowPicker from './AlarmWindowPicker.vue';
import AlarmFilterRow from './AlarmFilterRow.vue';
import { useAlarmWindow, presetFromMs } from './useAlarmWindow';
import { useAlarmFilters } from './useAlarmFilters';
import { formatAlarmEntity } from '@/utils/alarmEntity';
import { mergeIncidents, type AlarmIncident } from '@/utils/alarmIncidents';

const { t } = useI18n();

const timeWindow = useAlarmWindow();
const { windowMode, startTime, endTime, formatWindowLabel } = timeWindow;

const { capabilities } = useOapInfo();
const hasQueryAlarms = computed<boolean>(() => capabilities.value.queryAlarms);

const pageConfig = useQuery({
  queryKey: ['alarms/config'],
  queryFn: (): Promise<AlarmsConfig> => bff.alarms.config(),
  staleTime: Infinity,
});
const pinnedLayers = computed<string[]>(() => pageConfig.data.value?.pinnedLayers ?? []);

/* Apply the admin-configured default window once; after that the
 * operator's manual picker choice wins and must not snap back on a
 * pageConfig refetch (flag lives outside the `data` reactive). */
let didApplyDefault = false;
watch(
  () => pageConfig.data.value?.defaultWindowMs,
  (ms) => {
    if (didApplyDefault || ms === undefined) return;
    windowMode.value = presetFromMs(ms);
    didApplyDefault = true;
  },
  { immediate: true },
);

const filters = useAlarmFilters(hasQueryAlarms);
const { applied } = filters;

/* The header layer chips narrow the rendered list to that layer
 * (client-side filter on top of the fetched response). The selection
 * lives in the URL `?layer=GENERAL` so refresh / share preserves it
 * AND so the chip state survives a navigation. Empty / 'all' means
 * no chip filter active. */
const route = useRoute();
const router = useRouter();
const chipLayer = computed<string>({
  get: () => {
    const raw = route.query.layer;
    if (typeof raw === 'string') return raw.toUpperCase();
    return '';
  },
  set: (v: string) => {
    router.replace({ query: { ...route.query, layer: v ? v : undefined } });
  },
});
function selectChip(layerKey: string): void {
  chipLayer.value = layerKey === chipLayer.value ? '' : layerKey;
}

function keyFor(a: AlarmMessage): string {
  return `${a.id}::${a.startTime}`;
}
const selectedAlarmKey = ref<string | null>(null);
const selectedRange = ref<{ startTime: number; endTime: number } | null>(null);

/* Picking an alarm and brushing a range are NOT mutually exclusive:
 * the operator typically brushes first to narrow the rows, then
 * clicks one to inspect. Clearing the brush on row-click yanked the
 * list out from under the click and surprised everyone. Now row
 * selection only sets the alarm; the brush survives so the list
 * stays narrowed. Brushing still clears any alarm selection (a new
 * brush implies the operator is re-narrowing, and the previously
 * selected alarm may not be in the new slice). */
function selectAlarm(key: string): void {
  selectedAlarmKey.value = key;
}
function selectRange(r: { startTime: number; endTime: number }): void {
  selectedRange.value = r;
  selectedAlarmKey.value = null;
}
function clearSelection(): void {
  selectedAlarmKey.value = null;
  selectedRange.value = null;
}

const alarmsQuery = useQuery({
  queryKey: computed(() => [
    'alarms',
    startTime.value,
    endTime.value,
    applied.value.layer,
    applied.value.service,
    applied.value.instance,
    applied.value.endpoint,
    applied.value.keyword,
  ]),
  queryFn: (): Promise<AlarmsResponse> =>
    bff.alarms.list({
      startTime: startTime.value,
      endTime: endTime.value,
      layer: applied.value.layer || undefined,
      service: applied.value.service || undefined,
      instance: applied.value.instance || undefined,
      endpoint: applied.value.endpoint || undefined,
      keyword: applied.value.keyword || undefined,
    }),
  staleTime: Infinity,
  refetchOnWindowFocus: false,
});

const alarms = computed<AlarmMessage[]>(() => alarmsQuery.data.value?.msgs ?? []);
const truncated = computed<boolean>(() => alarmsQuery.data.value?.truncated ?? false);

/** Events narrowed by the brushed time range. Drives the KPI + tab
 *  counts after incident merging. The chip / tab layer filter is
 *  applied LATER (on incidents), not here — otherwise every chip
 *  except the active one would zero out. */
const rangeScopedAlarms = computed<AlarmMessage[]>(() => {
  if (!selectedRange.value) return alarms.value;
  const { startTime: s, endTime: e } = selectedRange.value;
  return alarms.value.filter((a) => a.startTime >= s && a.startTime <= e);
});

/* ── Incident-merged view ────────────────────────────────────────
 * (entity, rule) → one incident. The page's counts + list operate
 * on incidents; the Timeline operates on raw events (so the
 * fire-then-recovered pattern stays visible).
 *
 * Per spec: an incident whose LATEST event has recoveryTime !== null
 * is "recovered" and does NOT count in totals / tabs / badges. Only
 * `state === 'firing'` incidents are counted. */
const rangeIncidents = computed<AlarmIncident[]>(() =>
  mergeIncidents(rangeScopedAlarms.value),
);

const countsByLayer = computed<Map<string, number>>(() => {
  const m = new Map<string, number>();
  for (const inc of rangeIncidents.value) {
    if (inc.state === 'recovered') continue;  // unstable is still actively firing
    const k = inc.layerKey ?? 'OTHER';
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
});
const totalCount = computed<number>(
  () => rangeIncidents.value.filter((i) => i.state !== 'recovered').length,
);
/** Pinned layers always render in the header even when count = 0. */
const pinnedKpis = computed<Array<{ key: string; label: string; count: number }>>(() => {
  return pinnedLayers.value.map((k) => ({
    key: k,
    label: prettyLayer(k),
    count: countsByLayer.value.get(k) ?? 0,
  }));
});
/** "Other" KPI tile — the residual between `totalCount` and the
 *  pinned-layer counts. Surfaces alarms in layers the operator didn't
 *  pin AND alarms the BFF couldn't attribute to a known layer (bucket
 *  key === 'OTHER'). Without this tile the math `totalCount === sum
 *  of visible KPI tiles` reads as broken because the overflow pills
 *  below are smaller and easy to miss. The tile becomes a passthrough
 *  filter when clicked — same selectChip dispatch as a pinned layer. */
const otherKpiCount = computed<number>(() => {
  const pinned = new Set(pinnedLayers.value);
  let n = 0;
  for (const [k, v] of countsByLayer.value.entries()) {
    if (!pinned.has(k)) n += v;
  }
  return n;
});
/** Non-pinned layers with at least one active incident, descending
 *  by count. Recovered-only layers drop out — "no alarm as number".
 *  These render as small pills BELOW the KPI tiles; the "Other" KPI
 *  tile above already surfaces the aggregate count, so these are the
 *  detailed breakdown for triage filtering. */
const overflowChips = computed<Array<{ key: string; label: string; count: number }>>(() => {
  const pinned = new Set(pinnedLayers.value);
  const out: Array<{ key: string; label: string; count: number }> = [];
  for (const [k, n] of countsByLayer.value.entries()) {
    if (pinned.has(k)) continue;
    if (n === 0) continue;
    out.push({ key: k, label: prettyLayer(k), count: n });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
});

/** Row list uses the SAME incident merge as the counts: one row per
 *  (entity, rule). Re-firings of the same rule on the same entity
 *  collapse into a single row tagged "triggered N×"; the row's state
 *  reflects the latest firing (still firing or recovered). Recovered
 *  incidents stay visible in the list as recent history but already
 *  drop out of `totalCount` / `countsByLayer` above. */
const listEntries = computed<AlarmIncident[]>(() => rangeIncidents.value);
const filteredIncidents = computed<AlarmIncident[]>(() => {
  let rows = listEntries.value;
  if (chipLayer.value) {
    rows = rows.filter((i) => (i.layerKey ?? 'OTHER') === chipLayer.value);
  }
  return rows;
});

/* Expandable per-incident history — operators click the chevron to see
 * every individual firing/recovery on this (entity, rule) in time
 * order. Tracked by incident id; survives re-renders, cleared when the
 * page unmounts. The detail panel (right-side) keeps showing the latest
 * event regardless of which expanded sub-row is hovered. */
const expandedIncidents = ref<Set<string>>(new Set());
function isExpanded(id: string): boolean {
  return expandedIncidents.value.has(id);
}
function toggleExpanded(id: string): void {
  const next = new Set(expandedIncidents.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedIncidents.value = next;
}

/** Per-state labels for the row. */
function stateBadgeLabel(inc: AlarmIncident): string {
  if (inc.state === 'recovered') {
    return inc.triggerCount > 1 ? `recovered · was triggered ${inc.triggerCount}×` : 'recovered';
  }
  if (inc.state === 'unstable') {
    const firingNow = inc.triggerCount - inc.recoveredCount;
    return `unstable · ${firingNow} firing, ${inc.recoveredCount} recovered`;
  }
  return inc.triggerCount > 1 ? `firing · triggered ${inc.triggerCount}×` : 'firing';
}
function stateBadgeClass(inc: AlarmIncident): string {
  if (inc.state === 'recovered') return 'is-ok';
  if (inc.state === 'unstable') return 'is-warn';
  return 'is-err';
}

/** Data feed for the timeline chart — chip-aware, range-IGNORANT.
 *  Brushing must not hide data outside the brush, otherwise the
 *  operator can't see other peaks to rebrush onto. The brush
 *  rectangle is the only visual marker for the selection. The
 *  timeline keeps every raw event (NOT incidents) so the firing /
 *  recovered pattern is fully visible. */
const timelineAlarms = computed<AlarmMessage[]>(() => {
  if (!chipLayer.value) return alarms.value;
  return alarms.value.filter((a) => (a.layerKey ?? 'OTHER') === chipLayer.value);
});

const selectedAlarm = computed<AlarmMessage | null>(() => {
  const k = selectedAlarmKey.value;
  if (!k) return null;
  return alarms.value.find((a) => keyFor(a) === k) ?? null;
});

/* "All" maps to no layer filter; every other tab maps to its layer key
 * via `chipLayer` — the same state the header KPIs + overflow chips
 * write, so the two surfaces stay consistent. */
interface ListTab {
  key: string;
  label: string;
  count: number;
}
const listTabs = computed<ListTab[]>(() => {
  /* "All" uses `totalCount` (range-scoped), not `alarms.value.length`,
   * so it stays in sync with the per-layer counts after a brush. */
  const tabs: ListTab[] = [{ key: '', label: t('All'), count: totalCount.value }];
  for (const k of pinnedLayers.value) {
    tabs.push({ key: k, label: prettyLayer(k), count: countsByLayer.value.get(k) ?? 0 });
  }
  for (const c of overflowChips.value) {
    tabs.push({ key: c.key, label: c.label, count: c.count });
  }
  return tabs;
});

const PAGE_SIZE = 10;
const page = ref<number>(1);
const totalPages = computed<number>(
  () => Math.max(1, Math.ceil(filteredIncidents.value.length / PAGE_SIZE)),
);
const pagedIncidents = computed<AlarmIncident[]>(() => {
  const start = (page.value - 1) * PAGE_SIZE;
  return filteredIncidents.value.slice(start, start + PAGE_SIZE);
});

watch([filteredIncidents, chipLayer, startTime, endTime], () => {
  page.value = 1;
});

function prettyLayer(k: string): string {
  if (k === 'OTHER') return t('Other');
  return k
    .toLowerCase()
    .split('_')
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : ''))
    .join(' ');
}

function formatRelative(ts: number): string {
  const delta = Date.now() - ts;
  if (delta < 0) return new Date(ts).toLocaleString();
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
}

watch([startTime, endTime], () => {
  selectedRange.value = null;
});

const refreshing = ref(false);
async function onRefresh(): Promise<void> {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    timeWindow.resetEndToNow();
    await alarmsQuery.refetch();
  } finally {
    refreshing.value = false;
  }
}
</script>

<template>
  <div class="ax">
    <header class="ax__head">
      <div>
        <div class="ax__kicker">{{ t('Alarms') }}</div>
        <h1 class="ax__h1">{{ t('Active alarms') }}</h1>
        <p class="ax__lede">
          <i18n-t keypath="{window}. Pinned layers come from {setupLink}. Click a layer chip to narrow the list; click a flag on the timeline to inspect one alarm; brush a region to slice the list to that window." tag="span" scope="global">
            <template #window>{{ formatWindowLabel() }}</template>
            <template #setupLink>
              <RouterLink to="/admin/alert-page-setup">{{ t('Alert page setup') }}</RouterLink>
            </template>
          </i18n-t>
        </p>
      </div>
      <div class="ax__header-actions">
        <AlarmWindowPicker :window="timeWindow" part="buttons" />
        <button
          type="button"
          class="ax__refresh"
          :disabled="refreshing"
          @click="onRefresh"
        >{{ refreshing ? t('refreshing…') : t('refresh') }}</button>
      </div>
    </header>

    <AlarmWindowPicker :window="timeWindow" part="editor" />

    <div class="ax__kpis">
      <button
        type="button"
        class="ax__kpi ax__kpi--total"
        :class="{ active: !chipLayer }"
        @click="chipLayer = ''"
      >
        <div class="ax__kpi-label">{{ t('Active') }}</div>
        <div class="ax__kpi-val" :class="{ 'ax__kpi-val--err': totalCount > 0 }">{{ totalCount }}</div>
        <div class="ax__kpi-sub">{{ rangeIncidents.length === 1 ? t('{n} incident', { n: rangeIncidents.length }) : t('{n} incidents', { n: rangeIncidents.length }) }}</div>
      </button>
      <button
        v-for="k in pinnedKpis"
        :key="k.key"
        type="button"
        class="ax__kpi"
        :class="{ active: chipLayer === k.key }"
        @click="selectChip(k.key)"
      >
        <div class="ax__kpi-label">{{ k.label }}</div>
        <div class="ax__kpi-val" :class="{ 'ax__kpi-val--err': k.count > 0 }">{{ k.count }}</div>
      </button>
      <!-- "Other" KPI tile — sum of all non-pinned-layer alarms (and
           unmapped / 'OTHER' bucket). Always rendered (even at zero)
           so operators can mentally verify
           `Active = General + Mesh + Other` at a glance. Read-only
           aggregate; clicking it doesn't filter. The smaller pills
           below remain the per-layer filters. Rendered as a
           `<button disabled>` (not a `<div>`) so the flex row's
           box-metrics match the neighbour KPI buttons exactly —
           same padding / border / line-height resolution. -->
      <button
        type="button"
        disabled
        class="ax__kpi ax__kpi--passive"
        :title="t('Sum of alarms in non-pinned layers (and unmapped). Use the chips below to filter by a specific other layer.')"
      >
        <div class="ax__kpi-label">{{ t('Other') }}</div>
        <div class="ax__kpi-val" :class="{ 'ax__kpi-val--err': otherKpiCount > 0 }">{{ otherKpiCount }}</div>
      </button>
      <div v-if="overflowChips.length > 0" class="ax__chips">
        <button
          v-for="c in overflowChips"
          :key="c.key"
          type="button"
          class="ax__chip"
          :class="{ active: chipLayer === c.key }"
          @click="selectChip(c.key)"
        >
          <span class="ax__chip-label">{{ c.label }}</span>
          <span class="ax__chip-count mono">{{ c.count }}</span>
        </button>
      </div>
    </div>

    <AlarmFilterRow :filters="filters" :has-query-alarms="hasQueryAlarms" />

    <section class="ax__panel">
      <header class="ax__panel-head">
        <h3>{{ t('Timeline') }}</h3>
        <button
          type="button"
          class="ax__panel-reset"
          :disabled="!selectedRange && !selectedAlarmKey"
          :title="t('Clear the selected time range / alarm')"
          @click="clearSelection"
        >{{ t('reset') }}</button>
        <span v-if="alarmsQuery.isFetching.value" class="ax__refreshing">{{ t('loading…') }}</span>
        <span v-else-if="truncated" class="ax__panel-warn">
          {{ t('showing {n} rows (page may be truncated — tighten the window)', { n: totalCount }) }}
        </span>
      </header>
      <AlarmsTimeline
        :alarms="timelineAlarms"
        :start-time="startTime"
        :end-time="endTime"
        :selected-range="selectedRange"
        :height="110"
        @select-time-range="selectRange"
        @clear-selection="clearSelection"
      />
    </section>

    <section class="ax__split">
      <div class="ax__list">
        <div v-if="listTabs.length > 1" class="ax__tabs" role="tablist">
          <button
            v-for="t in listTabs"
            :key="t.key || '_all'"
            type="button"
            role="tab"
            class="ax__tab"
            :class="{ active: chipLayer === t.key }"
            :aria-selected="chipLayer === t.key"
            @click="chipLayer = t.key"
          >
            <span class="ax__tab-label">{{ t.label }}</span>
            <span class="ax__tab-count mono">{{ t.count }}</span>
          </button>
        </div>

        <div v-if="alarmsQuery.isPending.value" class="ax__empty">{{ t('loading…') }}</div>
        <div v-else-if="filteredIncidents.length === 0" class="ax__empty">
          {{ t('No alarms in the current window.') }}
        </div>

        <!-- One row per (entity, rule) incident. Click selects the
             incident's LATEST event for the detail panel — that's the
             one with the freshest snapshot. Incidents with N>1
             firings show a "triggered N times" subnote. -->
        <ul v-else class="ax__rows">
          <template v-for="inc in pagedIncidents" :key="inc.id">
            <li
              class="ax__row"
              :class="{
                active: keyFor(inc.latest) === selectedAlarmKey,
                resolved: inc.state === 'recovered',
                unstable: inc.state === 'unstable',
              }"
              @click="selectAlarm(keyFor(inc.latest))"
            >
              <span class="ax__sev" :class="['ax__sev--' + inc.state]" />
              <div class="ax__row-main">
                <div class="ax__row-entity">
                  <span class="ax__row-kind">{{ formatAlarmEntity(inc.latest.scope, inc.latest.name).prefix }}</span>
                  <code class="ax__row-entity-name">
                    <template v-for="(s, i) in formatAlarmEntity(inc.latest.scope, inc.latest.name).segments" :key="i">
                      <template v-if="s.kind === 'group'">
                        <span class="ax__row-entity-group">{{ s.group }}</span><span>{{ s.base }}</span>
                      </template>
                      <span v-else>{{ s.text }}</span>
                    </template>
                  </code>
                </div>
                <div class="ax__row-msg">{{ inc.latest.message }}</div>
                <div class="ax__row-meta">
                  <span v-if="inc.latest.layerKey" class="ax__row-tag">{{ prettyLayer(inc.latest.layerKey) }}</span>
                  <span v-else class="ax__row-tag ax__row-tag--other">{{ t('Other') }}</span>
                  <span class="ax__row-time">{{ formatRelative(inc.latest.startTime) }}</span>
                </div>
              </div>
              <span class="sw-badge" :class="stateBadgeClass(inc)">
                <span class="state-dot" />{{ stateBadgeLabel(inc) }}
              </span>
              <button
                v-if="inc.triggerCount > 1"
                type="button"
                class="ax__row-expand"
                :class="{ 'is-open': isExpanded(inc.id) }"
                :aria-expanded="isExpanded(inc.id)"
                :title="isExpanded(inc.id) ? t('Hide history') : t('Show all {n} events', { n: inc.triggerCount })"
                @click.stop="toggleExpanded(inc.id)"
              >▾</button>
              <span v-else class="ax__row-expand-placeholder" aria-hidden="true" />
            </li>
            <li
              v-if="isExpanded(inc.id) && inc.triggerCount > 1"
              class="ax__row-history"
              :key="inc.id + '::history'"
            >
              <ol>
                <li
                  v-for="(ev, evi) in inc.events"
                  :key="ev.startTime + '-' + evi"
                  class="ax__hist-row"
                  :class="{
                    active: keyFor(ev) === selectedAlarmKey,
                    'is-recovered': ev.recoveryTime !== null,
                  }"
                  @click.stop="selectAlarm(keyFor(ev))"
                >
                  <span class="ax__hist-idx mono">#{{ evi + 1 }}</span>
                  <span class="ax__hist-dot" :class="ev.recoveryTime !== null ? 'is-ok' : 'is-err'" />
                  <span class="ax__hist-label">
                    {{ ev.recoveryTime !== null ? t('recovered') : t('fired') }}
                  </span>
                  <span class="ax__hist-time mono">
                    {{ formatRelative(ev.recoveryTime ?? ev.startTime) }}
                  </span>
                </li>
              </ol>
            </li>
          </template>
        </ul>

        <nav v-if="totalPages > 1" class="ax__pager">
          <button
            type="button"
            class="ax__pager-btn"
            :disabled="page <= 1"
            @click="page = page - 1"
          >{{ t('‹ prev') }}</button>
          <span class="ax__pager-pos mono">{{ t('page {p} / {total}', { p: page, total: totalPages }) }}</span>
          <button
            type="button"
            class="ax__pager-btn"
            :disabled="page >= totalPages"
            @click="page = page + 1"
          >{{ t('next ›') }}</button>
        </nav>
      </div>

      <AlarmDetailPanel :alarm="selectedAlarm" />
    </section>
  </div>
</template>

<style scoped>
.ax {
  padding: 20px 20px 60px;
  max-width: 1600px;
  margin: 0 auto;
}
.ax__head {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 16px;
}
.ax__head > div:first-child { flex: 1; }
.ax__kicker {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--sw-accent);
  margin-bottom: 4px;
}
.ax__h1 {
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--sw-fg-0);
  margin: 0 0 8px;
}
.ax__lede {
  font-size: 12.5px;
  color: var(--sw-fg-1);
  line-height: 1.5;
  margin: 0;
  max-width: 820px;
}
.ax__lede a { color: var(--sw-accent); text-decoration: none; }
.ax__lede a:hover { text-decoration: underline; }

.ax__header-actions {
  display: flex;
  gap: 8px;
  align-items: stretch;
}
.ax__refresh {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-0);
  font: inherit;
  font-size: 11.5px;
  padding: 0 14px;
  border-radius: 6px;
  cursor: pointer;
  font-weight: 500;
}
.ax__refresh:not(:disabled):hover {
  background: var(--sw-bg-2);
  border-color: var(--sw-accent);
}
.ax__refresh:disabled { opacity: 0.55; cursor: not-allowed; }

.ax__kpis {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  gap: 10px;
  margin-bottom: 14px;
}
.ax__kpi {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  padding: 10px 16px;
  min-width: 120px;
  cursor: pointer;
  font: inherit;
  text-align: left;
  transition: border-color 0.1s ease;
}
.ax__kpi:hover { border-color: var(--sw-line-2); }
.ax__kpi.active {
  border-color: var(--sw-accent);
  box-shadow: inset 0 0 0 1px var(--sw-accent);
}
.ax__kpi--total {
  border-color: var(--sw-line-2);
}
/* opacity:1 overrides the browser-default disabled-button fade (~0.5)
 * so this read-only aggregate stays legible. */
.ax__kpi--passive {
  cursor: default;
  border-style: dashed;
  opacity: 1;
}
.ax__kpi--passive:hover {
  border-color: var(--sw-line);
}
.ax__kpi--passive .ax__kpi-label,
.ax__kpi--passive .ax__kpi-val {
  color: var(--sw-fg-2);
}
.ax__kpi-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--sw-fg-3);
  font-weight: 600;
}
.ax__kpi-val {
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--sw-fg-0);
  margin-top: 2px;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.ax__kpi-val--err { color: var(--sw-err); }
.ax__kpi-sub {
  font-size: 10.5px;
  color: var(--sw-fg-3);
  margin-top: 2px;
}
.ax__chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 10px 4px;
  margin-left: auto;
  max-width: 600px;
}
.ax__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  color: var(--sw-fg-1);
  font: inherit;
  font-size: 11.5px;
  padding: 4px 10px;
  border-radius: 12px;
  cursor: pointer;
}
.ax__chip:hover { background: var(--sw-bg-2); color: var(--sw-fg-0); }
.ax__chip.active {
  background: var(--sw-accent-soft);
  border-color: var(--sw-accent);
  color: var(--sw-accent-2);
}
.ax__chip-label { font-weight: 500; }
.ax__chip-count {
  font-size: 10.5px;
  color: var(--sw-fg-3);
  background: var(--sw-bg-2);
  padding: 0 5px;
  border-radius: 8px;
  font-variant-numeric: tabular-nums;
}
.ax__chip.active .ax__chip-count {
  background: var(--sw-bg-1);
  color: var(--sw-accent-2);
}

.ax__panel {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 16px;
}
.ax__panel-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  padding: 0 4px;
}
.ax__panel-head h3 {
  font-size: 12px;
  font-weight: 600;
  color: var(--sw-fg-1);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin: 0;
}
.ax__refreshing { margin-left: auto; font-size: 11px; color: var(--sw-fg-3); font-style: italic; }
.ax__panel-warn { margin-left: auto; font-size: 11px; color: var(--sw-warn); }
.ax__panel-reset {
  background: transparent;
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-2);
  font: inherit;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
}
.ax__panel-reset:not(:disabled):hover {
  border-color: rgba(239, 68, 68, 0.4);
  color: var(--sw-err);
  background: var(--sw-bg-2);
}
.ax__panel-reset:disabled { opacity: 0.35; cursor: not-allowed; }

.ax__split {
  display: grid;
  grid-template-columns: 1fr 360px;
  gap: 16px;
}
/* Narrow viewports: the fixed 360px detail rail + squeezed list overflow,
   so stack the detail below the list at full width instead. */
@media (max-width: 1080px) {
  .ax__split {
    grid-template-columns: 1fr;
  }
}
.ax__list { display: flex; flex-direction: column; gap: 12px; }
.ax__empty {
  padding: 24px;
  text-align: center;
  font-size: 12px;
  color: var(--sw-fg-3);
  background: var(--sw-bg-1);
  border: 1px dashed var(--sw-line);
  border-radius: 8px;
}
.ax__tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  padding: 4px;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  margin-bottom: -4px; /* visually attach to the rows below */
}
.ax__tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: 0;
  color: var(--sw-fg-2);
  font: inherit;
  font-size: 11.5px;
  padding: 5px 10px;
  border-radius: 5px;
  cursor: pointer;
}
.ax__tab:hover { background: var(--sw-bg-2); color: var(--sw-fg-0); }
.ax__tab.active {
  background: var(--sw-accent-soft);
  color: var(--sw-accent-2);
  font-weight: 600;
}
.ax__tab-label { line-height: 1; }
.ax__tab-count {
  font-size: 10px;
  color: var(--sw-fg-3);
  background: var(--sw-bg-2);
  padding: 1px 6px;
  border-radius: 8px;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
}
.ax__tab.active .ax__tab-count {
  background: var(--sw-bg-1);
  color: var(--sw-accent-2);
}
.ax__rows {
  list-style: none;
  margin: 0;
  padding: 0;
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  overflow: hidden;
}
.ax__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--sw-line);
  cursor: pointer;
  transition: background 0.1s ease;
}
.ax__row:last-child { border-bottom: none; }
.ax__row:hover { background: var(--sw-bg-2); }
.ax__row.active { background: var(--sw-bg-3); box-shadow: inset 2px 0 0 var(--sw-accent); }
.ax__row.resolved { opacity: 0.65; }
.ax__sev {
  width: 3px;
  height: 26px;
  border-radius: 2px;
  flex-shrink: 0;
}
.ax__sev.is-err { background: var(--sw-err); }
.ax__sev.is-ok { background: var(--sw-ok); }
.ax__sev--firing { background: var(--sw-err); }
.ax__sev--recovered { background: var(--sw-ok); }
.ax__sev--unstable { background: var(--sw-warn); }
.ax__row-main { flex: 1; min-width: 0; }
.ax__row-entity {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ax__row-kind {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--sw-accent);
  font-weight: 600;
  flex-shrink: 0;
}
.ax__row-entity code {
  font-family: var(--sw-mono);
  font-size: 11.5px;
  color: var(--sw-fg-0);
  background: transparent;
  padding: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ax__row-entity-name { display: inline-flex; align-items: baseline; gap: 0; }
.ax__row-entity-group {
  display: inline-block;
  font-family: var(--sw-mono);
  font-size: 9px;
  font-weight: 500;
  text-transform: lowercase;
  color: var(--sw-fg-2);
  background: var(--sw-bg-2);
  border: 1px solid var(--sw-line);
  padding: 0 5px;
  border-radius: 3px;
  margin-right: 5px;
  vertical-align: 1px;
  line-height: 1.5;
}
.ax__row-msg {
  font-size: 12px;
  color: var(--sw-fg-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ax__row-meta {
  font-size: 11px;
  color: var(--sw-fg-3);
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 3px;
}
.ax__row-meta code {
  font-family: var(--sw-mono);
  font-size: 10.5px;
  color: var(--sw-fg-1);
  background: var(--sw-bg-2);
  padding: 1px 5px;
  border-radius: 3px;
}
.ax__row-tag {
  font-size: 10px;
  color: var(--sw-fg-2);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.ax__row-tag--other { color: var(--sw-fg-3); }
.ax__row-time { margin-left: auto; font-variant-numeric: tabular-nums; }

.ax__pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 10px;
}
.ax__pager-btn {
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line-2);
  color: var(--sw-fg-1);
  font: inherit;
  font-size: 11.5px;
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
}
.ax__pager-btn:not(:disabled):hover { background: var(--sw-bg-2); color: var(--sw-fg-0); }
.ax__pager-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.ax__pager-pos { font-size: 11px; color: var(--sw-fg-2); font-variant-numeric: tabular-nums; }

.sw-badge .state-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  margin-right: 4px;
  display: inline-block;
  vertical-align: middle;
}
.sw-badge.is-ok { color: var(--sw-ok); background: var(--sw-ok-soft); border-color: rgba(34,197,94,0.3); }
.sw-badge.is-err { color: var(--sw-err); background: var(--sw-err-soft); border-color: rgba(239,68,68,0.3); }
.sw-badge.is-warn { color: var(--sw-warn); background: var(--sw-warn-soft); border-color: rgba(234,179,8,0.3); }

/* The chevron renders only when triggerCount > 1; otherwise the
   placeholder spacer keeps the row's grid alignment stable. */
.ax__row-expand,
.ax__row-expand-placeholder {
  width: 22px; height: 22px;
  display: inline-grid; place-items: center;
  margin-left: 8px;
  flex: 0 0 22px;
}
.ax__row-expand {
  background: transparent;
  border: 1px solid var(--sw-line-2);
  border-radius: 4px;
  color: var(--sw-fg-2);
  font-size: 12px;
  cursor: pointer;
  transition: transform 0.12s, border-color 0.1s, color 0.1s;
}
.ax__row-expand:hover {
  border-color: var(--sw-line-3);
  color: var(--sw-fg-0);
}
.ax__row-expand.is-open {
  transform: rotate(180deg);
  border-color: var(--sw-accent-line);
  color: var(--sw-accent-2);
}

.ax__row-history {
  list-style: none;
  margin: 0;
  padding: 0;
  background: var(--sw-bg-1);
  border-bottom: 1px solid var(--sw-line);
}
.ax__row-history ol {
  list-style: none;
  margin: 0;
  padding: 4px 14px 8px 56px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ax__hist-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 11.5px;
  color: var(--sw-fg-2);
  cursor: pointer;
}
.ax__hist-row:hover { background: var(--sw-bg-2); color: var(--sw-fg-1); }
.ax__hist-row.active { background: var(--sw-accent-soft); color: var(--sw-fg-0); }
.ax__hist-idx { color: var(--sw-fg-3); width: 28px; }
.ax__hist-dot {
  width: 6px; height: 6px; border-radius: 50%;
}
.ax__hist-dot.is-err { background: var(--sw-err); }
.ax__hist-dot.is-ok { background: var(--sw-ok); }
.ax__hist-label { flex: 1; }
.ax__hist-row.is-recovered .ax__hist-label { color: var(--sw-ok); }
.ax__hist-row:not(.is-recovered) .ax__hist-label { color: var(--sw-err); }
.ax__hist-time { color: var(--sw-fg-3); font-variant-numeric: tabular-nums; }
</style>
