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
  Calendar heatmap for overview dashboards: one cell per OAP-local bucket over
  a FIXED window of the last `windowDays` days ending now. A window of up to
  fourteen days (the HOUR-step ceiling) is drawn as days × 24 hours; a longer
  one as weeks × weekdays; `resolution` overrides the choice. The footer
  carries the window total (and a comparison to a well-known book).

  The one overview widget that does not follow the topbar time range. It reads
  the layer's landing route itself at the chosen step, so the overview
  composable skips it, and it refetches on the refresh round like the alarms
  card — the round decides, never a timer of its own. The window's identity
  (`windowDays`, the resolution) is in the query key and its bounds are re-read
  when the request is built, so a refetch keeps the previous cells on screen
  while the new read is out.
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useQuery } from '@tanstack/vue-query';
import {
  CALENDAR_HEATMAP_WINDOW_DAYS_DEFAULT,
  CALENDAR_HEATMAP_WINDOW_DAYS_MAX,
  CALENDAR_HEATMAP_WINDOW_DAYS_MIN,
  type CalendarHeatmapResolution,
  type LandingConfig,
  type LandingResponse,
} from '@skywalking-horizon-ui/api-client';
import { bffClient } from '@/api/client';
import { fetchDrawable } from '@/layer/graphQuery';
import { useAutoRefreshSubscribe } from '@/controls/useAutoRefreshSubscribe';
import { useRefreshErrorReport } from '@/controls/errorCenter';
import WidgetTip from '@/components/primitives/WidgetTip.vue';
import { formatValue } from './ValueFormat';
import {
  buildCalendarGrid,
  compareToWorks,
  DAY_MS,
  fitGrid,
  HOUR_MS,
  parseDay,
  parseHour,
  resolutionFor,
  transposeGrid,
  type AxisLabel,
  type CalendarCell,
  type CalendarGrid,
  type CalendarHeatmapSeries,
  type GridFit,
  type WorkComparison,
} from './calendarHeatmap';

const props = withDefaults(
  defineProps<{
    title: string;
    tip?: string;
    layer?: string;
    /** A per-service metric, read per service and aggregated across the layer. */
    mqe?: string;
    unit?: string;
    aggregation?: 'sum' | 'avg';
    windowDays?: number;
    resolution?: CalendarHeatmapResolution;
    compareTo?: boolean;
    /** Draw this instead of reading OAP — the admin canvas preview. */
    mock?: CalendarHeatmapSeries;
  }>(),
  { aggregation: 'sum', windowDays: CALENDAR_HEATMAP_WINDOW_DAYS_DEFAULT, resolution: 'auto', compareTo: false },
);

const { t, locale } = useI18n({ useScope: 'global' });

const days = computed(() =>
  Math.min(
    CALENDAR_HEATMAP_WINDOW_DAYS_MAX,
    Math.max(CALENDAR_HEATMAP_WINDOW_DAYS_MIN, Math.round(props.windowDays)),
  ),
);
const resolution = computed(() => (props.mock ? props.mock.resolution : resolutionFor(days.value, props.resolution)));

interface HeatmapRead {
  series: CalendarHeatmapSeries | null;
  metricsPartial: { failedChunks: number; totalChunks: number } | null;
  /** When the layer has more services than one read covers: how many were counted, of how many. */
  subset: { covered: number; total: number } | null;
}

/** The landing route caps the fan-out at this many services. */
const TOP_SERVICES = 8;

function toRead(res: LandingResponse): HeatmapRead {
  const values = res.aggregates.seriesByMetric['w_0'];
  const hourly = res.step === 'HOUR';
  const start = res.durationStart.slice(0, hourly ? 13 : 10);
  const readable = hourly ? parseHour(start) !== null : parseDay(start) !== null;
  const series = values && values.length > 0 && readable ? { resolution: hourly ? 'hour' : 'day', start, values } : null;
  const total = res.aggregates.serviceCount ?? res.sampledRows?.length ?? res.rows.length;
  const covered = res.rows.length;
  return {
    series: series as CalendarHeatmapSeries | null,
    metricsPartial: res.metricsPartial ?? null,
    subset: total > covered ? { covered, total } : null,
  };
}

const enabled = computed(() => props.mock === undefined && !!props.layer && !!props.mqe);
const queryKey = computed(() => [
  'overview-calendar-heatmap',
  props.layer ?? '',
  props.mqe ?? '',
  props.aggregation,
  days.value,
  resolution.value,
]);
const query = useQuery({
  queryKey,
  enabled,
  queryFn: ({ signal }) => {
    const endMs = Date.now();
    // Exactly `days` day buckets, or `days × 24` hour buckets, ending now.
    const hourly = resolution.value === 'hour';
    const startMs = hourly ? endMs - (days.value * 24 - 1) * HOUR_MS : endMs - (days.value - 1) * DAY_MS;
    const cfg: LandingConfig = {
      priority: 0,
      topN: TOP_SERVICES,
      orderBy: 'w_0',
      columns: [
        {
          metric: 'w_0',
          label: props.title || 'w_0',
          mqe: props.mqe ?? '',
          aggregation: props.aggregation,
          unit: props.unit,
          selfAggregate: false,
        },
      ],
    };
    return fetchDrawable(() =>
      bffClient.layer.landing(props.layer ?? '', cfg, { step: hourly ? 'HOUR' : 'DAY', startMs, endMs }, signal),
    ).then(toRead);
  },
  staleTime: 0,
  refetchOnWindowFocus: false,
});
useRefreshErrorReport({ owner: 'Overview', action: 'reading the usage grid', error: query.error });
useAutoRefreshSubscribe(() => query.refetch({ cancelRefetch: false }), enabled, () => queryKey.value);

const series = computed<CalendarHeatmapSeries | null>(() => props.mock ?? query.data.value?.series ?? null);
const grid = computed(() => (series.value ? buildCalendarGrid(series.value) : null));

// The body is measured so the cells can fill it, and so a card too narrow
// for the grid's long axis can turn the grid; the stylesheet's square cell
// stands until the first measurement (and where ResizeObserver is absent).
const GAP = 3;
const TOP_H = 12;
const GUTTER: Record<'weekday' | 'day' | 'hour', number> = { weekday: 30, day: 44, hour: 22 };
const bodyEl = ref<HTMLElement | null>(null);
const size = ref<{ w: number; h: number } | null>(null);
let observer: ResizeObserver | null = null;
watch(bodyEl, (el, old) => {
  if (typeof ResizeObserver === 'undefined') return;
  observer ??= new ResizeObserver((entries) => {
    const r = entries[0]?.contentRect;
    if (r) size.value = { w: r.width, h: r.height };
  });
  if (old) observer.unobserve(old);
  if (el) observer.observe(el);
});
onBeforeUnmount(() => observer?.disconnect());

function gutterFor(labels: ReadonlyArray<AxisLabel>): number {
  return GUTTER[labels.find((l) => l !== null)?.kind ?? 'day'];
}
const fit = computed<GridFit | null>(() => {
  const g = grid.value;
  const box = size.value;
  if (!g || !box) return null;
  return fitGrid(g.columns.length, g.rowLabels.length, {
    width: box.w,
    height: box.h,
    labelW: gutterFor(g.rowLabels),
    labelWTurned: gutterFor(g.columns.map((c) => c.label)),
    topH: TOP_H,
    gap: GAP,
  });
});
const shown = computed<CalendarGrid | null>(() => (grid.value ? (fit.value?.turned ? transposeGrid(grid.value) : grid.value) : null));
// A turn moves cells between rows, so the focused cell is made anew; the
// focus goes back to the same bucket once the turned grid is drawn.
watch(
  () => fit.value?.turned,
  () => {
    const active = typeof document === 'undefined' ? null : document.activeElement;
    if (!active || !bodyEl.value?.contains(active)) return;
    void nextTick(() => bodyEl.value?.querySelector<HTMLElement>('.cell[tabindex="0"]')?.focus());
  },
);
const layoutStyle = computed<Record<string, string>>(() => {
  const g = shown.value;
  if (!g) return {};
  const style: Record<string, string> = {
    '--cols': String(g.columns.length),
    '--rows': String(g.rowLabels.length),
    '--label-w': `${gutterFor(g.rowLabels)}px`,
  };
  if (fit.value) {
    style['--cell-w'] = `${fit.value.cellW}px`;
    style['--cell-h'] = `${fit.value.cellH}px`;
  }
  return style;
});
/** A day cell wide enough carries its day number, a wider one its value too. */
const boxes = computed(() => resolution.value === 'day' && fit.value !== null && fit.value.cellW >= 30 && fit.value.cellH >= 22);
const valuesInCells = computed(() => boxes.value && fit.value !== null && fit.value.cellW >= 72 && fit.value.cellH >= 36);
function dayNo(cell: CalendarCell): string {
  const ms = parseDay(cell.bucket);
  return ms === null ? '' : String(new Date(ms).getUTCDate());
}
function shortValue(cell: CalendarCell): string {
  return cell.value === null ? '' : formatValue(cell.value);
}
// A window of buckets that all came back empty is an empty window, not a
// grid of blank cells over a dash.
const hasData = computed(() => grid.value !== null && grid.value.total !== null);

type Phase = 'loading' | 'failed' | 'empty' | 'ready';
const phase = computed<Phase>(() => {
  if (props.mock !== undefined || !enabled.value) return hasData.value ? 'ready' : 'empty';
  if (query.data.value === undefined) return query.error.value ? 'failed' : 'loading';
  return hasData.value ? 'ready' : 'empty';
});
const refreshing = computed(() => query.isFetching.value && query.data.value !== undefined);
/** Every metric batch failed, so there is no series: say that, not "no data". */
const lostAll = computed(() => phase.value === 'empty' && (query.data.value?.metricsPartial ?? null) !== null);
const staleAfterFailure = computed(() => query.error.value !== null && query.data.value !== undefined);
const metricsPartial = computed(() => query.data.value?.metricsPartial ?? null);
const subset = computed(() => query.data.value?.subset ?? null);

const total = computed<number | null>(() => {
  if (!grid.value) return null;
  return props.aggregation === 'avg' ? grid.value.average : grid.value.total;
});
const comparison = computed<WorkComparison | null>(() =>
  props.compareTo && props.aggregation === 'sum' && total.value !== null ? compareToWorks(total.value) : null,
);

// `timeZone: 'UTC'` because the buckets are OAP-local wall-clock times
// carried as UTC instants; a local-time formatter would print the day before
// for anyone west of the OAP.
const dayFmt = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeZone: 'UTC' }));
const shortDayFmt = computed(() => new Intl.DateTimeFormat(locale.value, { month: 'short', day: 'numeric', timeZone: 'UTC' }));
// Component options, not `dateStyle`: the two cannot be combined, and the
// combination throws inside render.
const hourFmt = computed(
  () =>
    new Intl.DateTimeFormat(locale.value, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: 'UTC',
    }),
);
const weekdayFmt = computed(() => new Intl.DateTimeFormat(locale.value, { weekday: 'short', timeZone: 'UTC' }));
const numFmt = computed(() => new Intl.NumberFormat(locale.value, { maximumFractionDigits: 0 }));

/** Either axis: weekdays and hours as they are, dates on every slot up to
 *  eight and on every other one past that, so a long run keeps readable. */
function axisLabel(label: AxisLabel, i: number, n: number): string {
  if (!label) return '';
  // 2024-01-01 is a Monday; any Monday-anchored week serves as the reference.
  if (label.kind === 'weekday') return weekdayFmt.value.format(new Date(Date.UTC(2024, 0, 1 + label.weekday)));
  if (label.kind === 'hour') return String(label.hour).padStart(2, '0');
  if (n > 8 && i % 2 !== 0) return '';
  const ms = parseDay(label.day);
  return ms === null ? label.day : shortDayFmt.value.format(new Date(ms));
}

/** One cell holds the tab stop; the arrow keys move it, and every cell names
 *  its bucket and value, so a keyboard reader can walk the grid. */
const focused = ref<string | null>(null);
const focusKey = computed(() => {
  if (!shown.value) return null;
  const cells = shown.value.columns.flatMap((col) => col.cells).filter((c): c is CalendarCell => c !== null);
  if (focused.value && cells.some((c) => c.bucket === focused.value)) return focused.value;
  return cells.find((c) => c.isCurrent)?.bucket ?? cells[0]?.bucket ?? null;
});
function moveFocus(ev: KeyboardEvent, ci: number, r: number): void {
  const g = shown.value;
  if (!g) return;
  if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault();
    pick(g.columns[ci]?.cells[r]);
    return;
  }
  const step: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const d = step[ev.key];
  if (!d) return;
  ev.preventDefault();
  const gridEl = (ev.currentTarget as HTMLElement | null)?.parentElement ?? null;
  let [c, row] = [ci + d[0], r + d[1]];
  while (c >= 0 && c < g.columns.length && row >= 0 && row < g.rowLabels.length) {
    const cell = g.columns[c]!.cells[row];
    if (cell) {
      focused.value = cell.bucket;
      void nextTick(() => gridEl?.querySelector<HTMLElement>('.cell[tabindex="0"]')?.focus());
      return;
    }
    c += d[0];
    row += d[1];
  }
}

function cellClass(cell: CalendarCell | null | undefined): string[] {
  if (!cell) return ['blank'];
  return [`lvl-${cell.level}`, ...(cell.isCurrent ? ['current'] : []), ...(cell.bucket === picked.value ? ['picked'] : [])];
}
function cellTitle(cell: CalendarCell | null | undefined): string | undefined {
  if (!cell) return undefined;
  const hourly = resolution.value === 'hour';
  const ms = hourly ? parseHour(cell.bucket) : parseDay(cell.bucket);
  const when = ms === null ? cell.bucket : hourly ? hourFmt.value.format(new Date(ms)) : dayFmt.value.format(new Date(ms));
  const value = cell.value === null ? t('no data') : formatValue(cell.value, props.unit);
  if (!cell.isCurrent) return `${when} · ${value}`;
  return `${when} · ${value} · ${hourly ? t('this hour (incomplete)') : t('today (incomplete)')}`;
}

const totalText = computed(() => {
  const value = formatValue(total.value, props.unit);
  if (props.aggregation === 'avg') {
    return resolution.value === 'hour'
      ? t('Hourly average, last {n} days: {value}', { n: days.value, value })
      : t('Daily average, last {n} days: {value}', { n: days.value, value });
  }
  return t('Total, last {n} days: {value}', { n: days.value, value });
});
const comparisonText = computed(() => {
  const c = comparison.value;
  if (!c) return '';
  if (c.kind === 'percent') {
    return t('about {n}% of the text of {title}', { n: c.percent < 1 ? '<1' : numFmt.value.format(c.percent), title: c.title });
  }
  return t('about {n} times the text of {title}', { n: c.times >= 100 ? numFmt.value.format(c.times) : c.times.toFixed(1), title: c.title });
});

// A clicked cell stays picked, and the footer reads its date and value out,
// so a value can be read without hovering. Picking follows the bucket, not
// the position, so a refetch or a turn of the grid keeps it.
const picked = ref<string | null>(null);
const pickedCell = computed<CalendarCell | null>(() => {
  if (!picked.value || !shown.value) return null;
  return shown.value.columns.flatMap((col) => col.cells).find((c) => c !== null && c.bucket === picked.value) ?? null;
});
function pick(cell: CalendarCell | null | undefined): void {
  if (!cell) return;
  picked.value = picked.value === cell.bucket ? null : cell.bucket;
  focused.value = cell.bucket;
}
const pickedText = computed(() => (pickedCell.value ? cellTitle(pickedCell.value) : ''));
</script>

<template>
  <section class="sw-card hm">
    <header>
      <h4>{{ title }}</h4>
      <WidgetTip :tip="tip" />
      <span class="window-tag">· {{ t('last {n}d', { n: days }) }} · {{ resolution === 'hour' ? t('by hour') : t('by day') }}</span>
      <span v-if="refreshing" class="reading">{{ t('Reading data…') }}</span>
    </header>

    <div v-if="phase === 'loading'" class="empty">
      <span class="reading-dot" />
      <span>{{ t('Reading data…') }}</span>
    </div>
    <div v-else-if="phase === 'failed'" class="empty">{{ t('Could not read {title}.', { title }) }}</div>
    <div v-else-if="lostAll" class="empty">{{ t('Could not read {title}.', { title }) }}</div>
    <div v-else-if="phase === 'empty' || !shown" class="empty">{{ t('No data in the last {n} days.', { n: days }) }}</div>
    <template v-else>
      <div
        ref="bodyEl"
        class="body"
        :class="[shown.resolution, { turned: fit?.turned === true, boxes }]"
        :style="layoutStyle"
      >
        <div class="grid">
          <span class="corner" />
          <span v-for="(col, ci) in shown.columns" :key="`m${ci}`" class="col-label">
            {{ axisLabel(col.label, ci, shown.columns.length) }}
          </span>
          <template v-for="(label, r) in shown.rowLabels" :key="`r${r}`">
            <span class="row-label">{{ axisLabel(label, r, shown.rowLabels.length) }}</span>
            <span
              v-for="(col, ci) in shown.columns"
              :key="col.cells[r] ? col.cells[r]!.bucket : `blank-${ci}-${r}`"
              class="cell"
              :class="cellClass(col.cells[r])"
              :title="cellTitle(col.cells[r])"
              :role="col.cells[r] ? 'button' : undefined"
              :aria-pressed="col.cells[r] ? col.cells[r]!.bucket === picked : undefined"
              :aria-label="cellTitle(col.cells[r])"
              :tabindex="col.cells[r] ? (col.cells[r]!.bucket === focusKey ? 0 : -1) : undefined"
              @keydown="col.cells[r] && moveFocus($event, ci, r)"
              @focus="col.cells[r] && (focused = col.cells[r]!.bucket)"
              @click="pick(col.cells[r])"
            >
              <template v-if="col.cells[r] && boxes">
                <span class="day-no">{{ dayNo(col.cells[r]!) }}</span>
                <span v-if="valuesInCells" class="cell-val">{{ shortValue(col.cells[r]!) }}</span>
              </template>
            </span>
          </template>
        </div>
      </div>
      <footer>
        <span class="total">{{ totalText }}</span>
        <span v-if="comparisonText" class="compare">{{ comparisonText }}</span>
        <span v-if="pickedText" class="picked-out">{{ pickedText }}</span>
        <span v-if="subset" class="note">{{ t('The {covered} busiest of {total} services; the rest are not counted.', { covered: subset.covered, total: subset.total }) }}</span>
        <span v-if="staleAfterFailure" class="note">{{ t('The last read failed — showing the previous values.') }}</span>
        <span v-else-if="metricsPartial" class="note">
          {{ t('Some metrics could not be loaded ({failed} of {total} batches failed) — blank values may be unavailable, not zero.', { failed: metricsPartial.failedChunks, total: metricsPartial.totalChunks }) }}
        </span>
      </footer>
    </template>
  </section>
</template>

<style scoped>
.hm { display: flex; flex-direction: column; padding: 10px 12px; gap: 8px; min-height: 0; height: 100%; }
header { display: flex; align-items: center; gap: 6px; min-width: 0; }
h4 {
  margin: 0; font-size: 11px; font-weight: 600; color: var(--sw-fg-1);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
.window-tag { font-size: 11px; color: var(--sw-fg-3); white-space: nowrap; }
.reading { margin-left: auto; font-size: 10px; color: var(--sw-fg-3); white-space: nowrap; }
.empty {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px;
  font-size: 11px; color: var(--sw-fg-3); text-align: center;
}
.reading-dot {
  width: 6px; height: 6px; border-radius: 50%; background: var(--sw-accent);
  animation: hm-pulse 1.2s ease-in-out infinite;
}
@keyframes hm-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }

/* The body is a size container so that, until it is measured, the cell is
   the LARGER square that still fits both ways: the rows inside the card's
   fixed height, and the columns across its width. Once measured the script
   sets the cell's width and height separately, so the cells fill the card. */
.body {
  --gap: 3px;
  --label-w: 44px;
  --top-h: 12px;
  --cell: max(
    4px,
    min(
      calc((100cqw - var(--label-w) - var(--cols) * var(--gap)) / var(--cols)),
      calc((100cqh - var(--top-h) - var(--rows) * var(--gap)) / var(--rows))
    )
  );
  container-type: size;
  flex: 1;
  min-height: 84px;
  display: flex;
  align-items: center;
}
.grid {
  display: grid;
  grid-template-columns: var(--label-w) repeat(var(--cols), var(--cell-w, var(--cell)));
  grid-template-rows: var(--top-h) repeat(var(--rows), var(--cell-h, var(--cell)));
  gap: var(--gap);
}
.col-label, .row-label {
  font-size: 9px; color: var(--sw-fg-3); line-height: 1;
  white-space: nowrap; overflow: visible; align-self: end;
}
.row-label { align-self: center; }
.cell { position: relative; overflow: hidden; border-radius: 2px; background: var(--sw-bg-3); min-width: 0; min-height: 0; }
.day-no, .cell-val { position: absolute; line-height: 1; color: var(--sw-fg-0); text-shadow: 0 0 2px var(--sw-bg-0); pointer-events: none; }
.day-no { top: 2px; left: 4px; font-size: 9px; opacity: 0.8; }
.cell-val { right: 4px; bottom: 3px; font-size: 9.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
.cell.blank { background: transparent; }
/* Five shades of the theme's accent, mixed towards the empty cell so every
   theme's primary colour reads as its own ramp. */
.cell.lvl-1 { background: color-mix(in srgb, var(--sw-accent) 22%, var(--sw-bg-3)); }
.cell.lvl-2 { background: color-mix(in srgb, var(--sw-accent) 42%, var(--sw-bg-3)); }
.cell.lvl-3 { background: color-mix(in srgb, var(--sw-accent) 62%, var(--sw-bg-3)); }
.cell.lvl-4 { background: color-mix(in srgb, var(--sw-accent) 82%, var(--sw-bg-3)); }
.cell.lvl-5 { background: var(--sw-accent); }
.cell { cursor: pointer; }
.cell.blank { cursor: default; }
.cell.current { box-shadow: inset 0 0 0 1px var(--sw-fg-1); }
.cell.picked { box-shadow: inset 0 0 0 2px var(--sw-fg-0); }
.cell:focus-visible { outline: 2px solid var(--sw-accent); outline-offset: 1px; }

footer {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px;
  border-top: 1px dashed var(--sw-line); padding-top: 6px;
  font-size: 11px; min-width: 0;
}
.total { color: var(--sw-fg-0); font-weight: 600; font-variant-numeric: tabular-nums; }
.compare { color: var(--sw-fg-2); font-variant-numeric: tabular-nums; }
.picked-out { margin-left: auto; color: var(--sw-fg-0); font-variant-numeric: tabular-nums; }
.note { flex-basis: 100%; font-size: 10px; color: var(--sw-warn); }
</style>
