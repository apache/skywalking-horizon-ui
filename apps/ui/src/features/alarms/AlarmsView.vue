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
  Alarms triage page — the default page at /alarms, and every named page at
  /alarms/<id>. The default page lists every alarm the reader's alarms:read
  reaches; a named page lists only those its pins cover, filtered by the BFF,
  and has no Other and no tab for an unpinned layer. Layout:

   ┌── header ─────────────────────────────────────────────────────┐
   │ Alarms                       [20m] [2h] [4h] [custom] [↻]    │
   ├── KPI strip ──────────────────────────────────────────────────┤
   │  ACTIVE · …one tile per pin… · OTHER (default page only)     │
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
          gracefully no-op; the tiles and tabs still filter the
          fetched response client-side.
-->
<script setup lang="ts">
import { computed, ref, toRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  bff,
  BffApiError,
  describeApiError,
  type AlarmMessage,
  type AlarmsResponse,
} from '@/api/client';
import { useOapInfo } from '@/shell/useOapInfo';
import { ALARM_PAGES_QUERY_KEY } from '@/shell/useAlarmPages';
import { useAuthStore } from '@/state/auth';
import AlarmsTimeline from '@/components/charts/AlarmsTimeline.vue';
import AlarmDetailPanel from './AlarmDetailPanel.vue';
import AlarmWindowPicker from './AlarmWindowPicker.vue';
import AlarmFilterRow from './AlarmFilterRow.vue';
import { useAlarmWindow, presetFromMs } from './useAlarmWindow';
import { useAlarmFilters } from './useAlarmFilters';
import { useAlarmPage, type AlarmPageState } from './useAlarmPage';
import { OTHER_CHIP, canonicalPin, chipKeyOf, prettyLayer, useAlarmPins } from './useAlarmPins';
import { formatAlarmEntity } from '@/utils/alarmEntity';
import {
  alarmIncidentKey,
  alarmLayerKeys,
  alarmOwnerKeys,
  mergeIncidents,
  type AlarmIncident,
} from '@/utils/alarmIncidents';

/** Absent on the default page, `/alarms`; a named page's id otherwise. */
const props = defineProps<{ pageId?: string }>();

const { t } = useI18n();
const auth = useAuthStore();

const timeWindow = useAlarmWindow();
const { startTime, endTime, formatWindowLabel } = timeWindow;

const { capabilities } = useOapInfo();
const hasQueryAlarms = computed<boolean>(() => capabilities.value.queryAlarms);

const alarmPage = useAlarmPage(toRef(props, 'pageId'));
const pageReady = computed<boolean>(() => alarmPage.state.value === 'ready');
const pinsOnly = computed<boolean>(() => !alarmPage.isDefault.value);
/** The pins a named page's rows were read by, from the read itself. */
const listPins = ref<string[] | null>(null);
/** A named page draws the pins its rows were chosen by, so its tiles, tabs
 *  and filter choices cannot disagree with its list; before the first read,
 *  the pins the pages route served. */
const drawnPins = computed<readonly string[]>(() =>
  props.pageId && listPins.value ? listPins.value : alarmPage.pinnedLayers.value,
);
/** A named page's pins as the pages route serves them; empty on the default
 *  page, whose rows and choices do not depend on its pins. */
const servedPinsKey = computed<string>(() => (props.pageId ? alarmPage.pinnedLayers.value.join('|') : ''));

/* Each page's starting window is applied once, when it is first known; after
 * that the operator's picker choice wins and a refetch of the pages must not
 * snap it back. Arriving on another page applies that page's. A window that
 * is already the page's is left alone, so it is not read a second time.
 *
 * Declared before the alarms read, so on a page change it runs before the
 * read's key is looked at; the read is not fired for the old window first. */
let windowAppliedFor: string | null = null;
watch(
  [() => props.pageId ?? '', alarmPage.windowMs],
  ([key, ms]) => {
    if (ms === undefined || windowAppliedFor === key) return;
    const preset = presetFromMs(ms);
    if (timeWindow.windowMode.value !== preset) timeWindow.pickPreset(preset);
    windowAppliedFor = key;
  },
  { immediate: true },
);

const filters = useAlarmFilters(hasQueryAlarms, toRef(props, 'pageId'), servedPinsKey);
/** A named page offers only its own layers to filter by. */
const pageLayers = computed<string[] | null>(() =>
  props.pageId ? [...new Set(drawnPins.value.map((p) => canonicalPin(p)?.layer).filter((l): l is string => !!l))] : null,
);
const { applied } = filters;

/* The tiles and tabs narrow the rendered list (client-side, on top of
 * the fetched response). The selection lives in the URL `?layer=` so refresh
 * / share preserves it; a named page's sidebar link carries none, so moving
 * between pages starts unnarrowed. */
const route = useRoute();
const router = useRouter();
const chipLayer = computed<string>({
  get: () => {
    const key = chipKeyOf(route.query.layer);
    // A named page offers its pins alone; `?layer=` naming anything else selects nothing.
    if (!pinsOnly.value || key === '') return key;
    return drawnPins.value.some((p) => chipKeyOf(p) === key) ? key : '';
  },
  set: (v: string) => {
    router.replace({ query: { ...route.query, layer: v ? v : undefined } });
  },
});
function selectChip(key: string): void {
  chipLayer.value = key === chipLayer.value ? '' : key;
}

function keyFor(a: AlarmMessage): string {
  return `${alarmIncidentKey(a)}::${a.startTime}`;
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
  enabled: pageReady,
  // A named page's rows are the ones its pins cover, chosen on the BFF: when
  // the served pins change (edited elsewhere, or the reader's grant moved),
  // those rows are another read, not a re-arrangement of these.
  queryKey: computed(() => [
    'alarms',
    props.pageId ?? '',
    servedPinsKey.value,
    startTime.value,
    endTime.value,
    applied.value.layer,
    applied.value.service,
    applied.value.serviceNormal,
    applied.value.instance,
    applied.value.endpoint,
    applied.value.keyword,
  ]),
  queryFn: ({ signal }): Promise<AlarmsResponse> =>
    bff.alarms.list({
      startTime: startTime.value,
      endTime: endTime.value,
      page: props.pageId,
      layer: applied.value.layer || undefined,
      service: applied.value.service || undefined,
      normal: applied.value.service ? applied.value.serviceNormal : undefined,
      instance: applied.value.instance || undefined,
      endpoint: applied.value.endpoint || undefined,
      keyword: applied.value.keyword || undefined,
    }, signal),
  staleTime: Infinity,
  refetchOnWindowFocus: false,
});

/* The BFF no longer serves this named page to the reader: it was deleted, or
 * their grant changed, since the pages were read. The page is not available,
 * and the pages are read again so the sidebar stops offering it. */
const pageGone = computed<boolean>(() => {
  const err = alarmsQuery.error.value;
  if (!(err instanceof BffApiError) || err.status !== 404) return false;
  const body = err.body;
  return typeof body === 'object' && body !== null && (body as { error?: unknown }).error === 'alarm_page_not_found';
});
const queryClient = useQueryClient();
// Rows read by pins the pages route has not served yet: another admin
// re-pinned the page. The pages are read again, so its title, window and
// sidebar entry follow too.
watch(
  () => alarmsQuery.data.value,
  (d) => {
    listPins.value = props.pageId && d?.pinnedLayers ? d.pinnedLayers : null;
    if (listPins.value && listPins.value.join('|') !== alarmPage.pinnedLayers.value.join('|')) {
      void queryClient.invalidateQueries({ queryKey: ALARM_PAGES_QUERY_KEY });
    }
  },
  { immediate: true },
);
watch(pageGone, (gone) => {
  if (gone) void queryClient.invalidateQueries({ queryKey: ALARM_PAGES_QUERY_KEY });
});
const pageState = computed<AlarmPageState>(() => (pageGone.value ? 'missing' : alarmPage.state.value));

// A failed read shows as failed, not as a window with no alarms: the rows of
// the read before it are dropped and the tiles show no count. A read still in
// flight (a new window, another page) shows no count either, not a zero.
const readFailed = computed(() => alarmsQuery.isError.value);
const countsUnknown = computed(() => readFailed.value || alarmsQuery.isPending.value);
const alarms = computed<AlarmMessage[]>(() => (readFailed.value ? [] : alarmsQuery.data.value?.msgs ?? []));
const truncated = computed<boolean>(() => !readFailed.value && (alarmsQuery.data.value?.truncated ?? false));
const kpi = (n: number): number | string => (countsUnknown.value ? '—' : n);

/** Events narrowed by the brushed time range. Drives the KPI + tab
 *  counts after incident merging. The tile / tab filter is applied
 *  LATER (on incidents), not here — otherwise every tile except the
 *  active one would zero out. */
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
 * is "recovered" and does NOT count in totals / tabs / badges. */
const rangeIncidents = computed<AlarmIncident[]>(() =>
  mergeIncidents(rangeScopedAlarms.value),
);

const { totalCount, pinnedTiles, otherCount, tabs: listTabs, inChip } = useAlarmPins({
  pinnedLayers: drawnPins,
  incidents: rangeIncidents,
  chip: chipLayer,
  pinsOnly,
});

/** Row list uses the SAME incident merge as the counts: one row per
 *  (entity, rule). Re-firings of the same rule on the same entity
 *  collapse into a single row tagged "triggered N×"; the row's state
 *  reflects the latest firing (still firing or recovered). Recovered
 *  incidents stay visible in the list as recent history but already
 *  drop out of the counts. */
const filteredIncidents = computed<AlarmIncident[]>(() =>
  chipLayer.value ? rangeIncidents.value.filter((i) => inChip(i)) : rangeIncidents.value,
);

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

/** Data feed for the timeline chart — selection-aware, range-IGNORANT.
 *  Brushing must not hide data outside the brush, otherwise the
 *  operator can't see other peaks to rebrush onto. The brush
 *  rectangle is the only visual marker for the selection. The
 *  timeline keeps every raw event (NOT incidents) so the firing /
 *  recovered pattern is fully visible. */
const timelineAlarms = computed<AlarmMessage[]>(() => {
  if (!chipLayer.value) return alarms.value;
  return alarms.value.filter((a) => inChip({ layerKeys: alarmLayerKeys(a), ownerKeys: alarmOwnerKeys(a) }));
});

const selectedAlarm = computed<AlarmMessage | null>(() => {
  const k = selectedAlarmKey.value;
  if (!k) return null;
  return alarms.value.find((a) => keyFor(a) === k) ?? null;
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

// Moving to another page starts it afresh; its window is re-applied above and
// ends now, so a page visited before is read again rather than served from the
// earlier read. The filter goes too: one left applied would narrow the next
// page's read, and its tiles would count only what that filter let through.
// `sync` because the read keys on the page id: declared after the read, a
// pre-flush watcher would run once the read had already fired for the new page
// with the old filter, and OAP would be asked twice.
watch(
  () => props.pageId,
  () => {
    timeWindow.resetEndToNow();
    filters.clearFilters();
    clearSelection();
    expandedIncidents.value = new Set();
    page.value = 1;
  },
  { flush: 'sync' },
);
// A named page whose pins change while it is open is another page to filter:
// a layer or service picked under the old pins may be one it no longer offers,
// and would narrow the new read to nothing.
watch(
  [() => props.pageId, servedPinsKey],
  ([id, pins], [prevId, prevPins]) => {
    if (id !== prevId || pins === prevPins) return;
    filters.clearFilters();
    clearSelection();
    expandedIncidents.value = new Set();
    page.value = 1;
  },
  { flush: 'sync' },
);

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

const pageNote = computed<string | null>(() => {
  if (alarmPage.setupUnread.value) return t('The default alarm page could not be read, so no layers are pinned.');
  const n = alarmPage.hiddenPins.value;
  if (n === 0) return null;
  return n === 1
    ? t('{n} pinned layer is outside your access.', { n })
    : t('{n} pinned layers are outside your access.', { n });
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
  <div v-if="pageState !== 'ready'" class="ax">
    <header class="ax__head">
      <div><div class="ax__kicker">{{ t('Alarms') }}</div></div>
    </header>
    <div v-if="pageState === 'loading'" class="ax__empty">{{ t('loading…') }}</div>
    <div v-else class="ax__empty" :class="{ 'ax__empty--err': pageState === 'failed' }">
      {{ pageState === 'failed' ? alarmPage.failure.value : t('This alarm page does not exist or is not available to you.') }}
      <RouterLink to="/alarms">{{ t('Alarms') }}</RouterLink>
    </div>
  </div>
  <div v-else class="ax">
    <header class="ax__head">
      <div>
        <div class="ax__kicker">{{ t('Alarms') }}</div>
        <h1 class="ax__h1">{{ alarmPage.title.value ?? t('Active alarms') }}</h1>
        <p class="ax__lede">
          <i18n-t v-if="auth.hasVerb('alarm-setup:read')" keypath="{window}. Pinned layers come from {setupLink}. Click a tile or a tab to narrow the list; click a flag on the timeline to inspect one alarm; brush a region to slice the list to that window." tag="span" scope="global">
            <template #window>{{ formatWindowLabel() }}</template>
            <template #setupLink>
              <RouterLink to="/admin/alert-page-setup">{{ t('Alarm pages') }}</RouterLink>
            </template>
          </i18n-t>
          <span v-else>{{ t('{window}. Click a tile or a tab to narrow the list; click a flag on the timeline to inspect one alarm; brush a region to slice the list to that window.', { window: formatWindowLabel() }) }}</span>
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
        <div class="ax__kpi-val" :class="{ 'ax__kpi-val--err': totalCount > 0 }">{{ kpi(totalCount) }}</div>
        <div v-if="!countsUnknown" class="ax__kpi-sub">{{ rangeIncidents.length === 1 ? t('{n} incident', { n: rangeIncidents.length }) : t('{n} incidents', { n: rangeIncidents.length }) }}</div>
      </button>
      <button
        v-for="k in pinnedTiles"
        :key="k.key"
        type="button"
        class="ax__kpi"
        :class="{ active: chipLayer === k.key }"
        @click="selectChip(k.key)"
      >
        <!-- OAP service groups are case-sensitive, so the group part is not upper-cased. -->
        <div class="ax__kpi-label">
          <template v-if="k.groupsLabel"><span class="ax__kpi-group">{{ k.groupsLabel }}</span> · </template>{{ k.layerLabel }}
        </div>
        <div class="ax__kpi-val" :class="{ 'ax__kpi-val--err': k.count > 0 }">{{ kpi(k.count) }}</div>
      </button>
      <!-- "Other": the active incidents no pin matches. Rendered even at
           zero on the default page; a named page lists nothing else. -->
      <button
        v-if="!pinsOnly"
        type="button"
        class="ax__kpi"
        :class="{ active: chipLayer === OTHER_CHIP }"
        :title="t('Alarms in no pinned layer, including those no known service owns. An alarm counts under every layer its services are in, so the layer tiles can add up to more than Active.')"
        @click="selectChip(OTHER_CHIP)"
      >
        <div class="ax__kpi-label">{{ t('Other') }}</div>
        <div class="ax__kpi-val" :class="{ 'ax__kpi-val--err': otherCount > 0 }">{{ kpi(otherCount) }}</div>
      </button>
    </div>

    <p v-if="pageNote" class="ax__note">{{ pageNote }}</p>

    <AlarmFilterRow :filters="filters" :has-query-alarms="hasQueryAlarms" :page-layers="pageLayers" />

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
          {{ t('more alarms in this window than were fetched — tighten the range') }}
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
            v-for="tab in listTabs"
            :key="tab.key || '_all'"
            type="button"
            role="tab"
            class="ax__tab"
            :class="{ active: chipLayer === tab.key }"
            :aria-selected="chipLayer === tab.key"
            @click="chipLayer = tab.key"
          >
            <span class="ax__tab-label">{{ tab.label }}</span>
            <span class="ax__tab-count mono">{{ kpi(tab.count) }}</span>
          </button>
        </div>

        <div v-if="alarmsQuery.isPending.value" class="ax__empty">{{ t('loading…') }}</div>
        <div v-else-if="readFailed" class="ax__empty ax__empty--err">
          {{ t('The alarms could not be read: {err}', { err: describeApiError(alarmsQuery.error.value) }) }}
        </div>
        <!-- An empty list from a read that stopped early proves nothing. -->
        <div v-else-if="filteredIncidents.length === 0" class="ax__empty">
          {{ truncated ? t('more alarms in this window than were fetched — tighten the range') : t('No alarms in the current window.') }}
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
                  <span v-if="inc.layerKeys.length" class="ax__row-tag">{{ inc.layerKeys.map(prettyLayer).join(' · ') }}</span>
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
.ax__kpi-group { text-transform: none; letter-spacing: 0; }
.ax__note {
  margin: -6px 0 12px;
  font-size: 11.5px;
  color: var(--sw-fg-3);
}
.ax__kpi-sub {
  font-size: 10.5px;
  color: var(--sw-fg-3);
  margin-top: 2px;
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
  /* minmax(0, …): a long nowrap message must not widen the list past its
     share and push the detail panel off the page. */
  grid-template-columns: minmax(0, 1fr) 360px;
  gap: 16px;
}
/* Narrow viewports: the fixed 360px detail rail + squeezed list overflow,
   so stack the detail below the list at full width instead. */
@media (max-width: 1080px) {
  .ax__split {
    grid-template-columns: minmax(0, 1fr);
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
.ax__empty--err { color: var(--sw-err); border-color: var(--sw-err); }
.ax__empty a { color: var(--sw-accent); text-decoration: none; margin-left: 6px; }
.ax__empty a:hover { text-decoration: underline; }
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
.ax__row-entity-name { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
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
