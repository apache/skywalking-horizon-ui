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
  Events swimlane (Gantt). Rows are grouped Layer → Service → Instance, or (in
  `flat` mode, used by the per-service popout) one row per instance. An event
  with a duration is a bar spanning start→end; one without an end is a diamond
  marker; overlapping events on one instance stack into sub-lanes; Error events
  carry a red ring.

  Scrolling is fully internal so the outer page never scrolls: a sticky time
  header + sticky label column, plus a per-hour minimum canvas width so a long
  range scrolls horizontally (opened at the newest) instead of smearing. The
  axis marks the date at day boundaries. Pure DOM/CSS, no chart library.
-->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { EventRow } from '@/api/client';
import { buildGantt, eventTs, type GanttBar } from './ganttLayout';

const { t } = useI18n();

const props = defineProps<{
  events: EventRow[];
  startTime: number;
  endTime: number;
  selectedUuid?: string | null;
  /** Flatten to instance rows only, dropping the Layer / Service headers. Used
   *  by the per-service popout, where the service is fixed (shown in the title)
   *  so the only axes that matter are instance (rows) and time (columns). */
  flat?: boolean;
  /** Flat mode only: case-insensitive substring; keeps only instance rows whose
   *  name matches. Empty shows every row. */
  rowFilter?: string;
}>();

const emit = defineEmits<{ (e: 'select-event', ev: EventRow): void }>();

const BAR_H = 20; // px per sub-lane
// Horizontal density: 6h / 1d fit the column; 2d+ overflow into a scroll at a
// legible bar spacing instead of smearing.
const PX_PER_HOUR = 26;
const MIN_TIME_PX = 480;

const layers = computed(() => buildGantt(props.events));
const isEmpty = computed<boolean>(() => layers.value.length === 0);

/** Minimum width (px) of the time canvas — grows with the window so bars stay
 *  legible on a long range; the column scrolls horizontally past the viewport. */
const timeMinPx = computed<number>(() => {
  const hours = (props.endTime - props.startTime) / 3_600_000;
  return Math.max(MIN_TIME_PX, Math.round(hours * PX_PER_HOUR));
});

const collapsed = ref<Set<string>>(new Set());
function isCollapsed(key: string): boolean {
  return collapsed.value.has(key);
}
function toggle(key: string): void {
  const next = new Set(collapsed.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsed.value = next;
}

interface DisplayRow {
  kind: 'layer' | 'service' | 'lane';
  key: string;
  label: string;
  indent: number;
  count?: number;
  color?: string;
  dot?: boolean;
  collapseKey?: string;
  collapsed?: boolean;
  bars?: GanttBar[];
  subLanes?: number;
}
const rows = computed<DisplayRow[]>(() => {
  const out: DisplayRow[] = [];
  // Flat: fixed service → no layer/service headers, one row per instance. Color
  // is a golden-angle hue per row (distinct at any count, starting at blue to
  // avoid the Error red), assigned over the FULL list so a row keeps its color
  // when the search filter narrows.
  if (props.flat) {
    let i = 0;
    for (const lg of layers.value) {
      for (const svc of lg.services) {
        for (const r of svc.rows) {
          out.push({ kind: 'lane', key: `${svc.key}/${r.instance}`, label: r.instance || t('(service-scoped)'), indent: 10, color: `hsl(${Math.round((210 + i * 137.508) % 360)}, 60%, 62%)`, dot: true, bars: r.bars, subLanes: r.subLanes });
          i++;
        }
      }
    }
    const q = (props.rowFilter ?? '').trim().toLowerCase();
    return q ? out.filter((row) => row.label.toLowerCase().includes(q)) : out;
  }
  for (const lg of layers.value) {
    const lk = `L:${lg.key}`;
    out.push({ kind: 'layer', key: lk, collapseKey: lk, collapsed: isCollapsed(lk), label: lg.layer, count: lg.eventCount, indent: 8 });
    if (isCollapsed(lk)) continue;
    for (const svc of lg.services) {
      if (svc.serviceScoped) {
        const r = svc.rows[0]!;
        out.push({ kind: 'lane', key: svc.key, label: svc.service, indent: 24, color: svc.color, dot: true, bars: r.bars, subLanes: r.subLanes });
        continue;
      }
      const sk = `S:${svc.key}`;
      out.push({ kind: 'service', key: sk, collapseKey: sk, collapsed: isCollapsed(sk), label: svc.service, count: svc.eventCount, color: svc.color, indent: 22 });
      if (isCollapsed(sk)) continue;
      for (const r of svc.rows) {
        out.push({ kind: 'lane', key: `${svc.key}/${r.instance}`, label: r.instance, indent: 40, color: svc.color, dot: false, bars: r.bars, subLanes: r.subLanes });
      }
    }
  }
  return out;
});

function clampPct(ts: number): number {
  const span = props.endTime - props.startTime;
  if (span <= 0) return 0;
  return Math.min(100, Math.max(0, ((ts - props.startTime) / span) * 100));
}
function widthPct(bar: GanttBar): number {
  if (bar.end === null) return 0;
  return Math.max(0, clampPct(bar.end) - clampPct(bar.start));
}
function rowH(subLanes: number): number {
  return subLanes * BAR_H;
}

const TICK_STEPS = [
  60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000,
  2 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000, 2 * 86_400_000, 7 * 86_400_000,
];
const ticks = computed<Array<{ pct: number; time: string; date: string }>>(() => {
  const span = props.endTime - props.startTime;
  if (span <= 0) return [];
  // ~1 tick per 130px of the (possibly wide) canvas.
  const target = Math.max(6, Math.round((timeMinPx.value + 240) / 130));
  const step = TICK_STEPS.find((s) => span / s <= target) ?? TICK_STEPS[TICK_STEPS.length - 1]!;
  const dayStep = step >= 86_400_000;
  const p = (n: number): string => String(n).padStart(2, '0');
  const out: Array<{ pct: number; time: string; date: string }> = [];
  let prevDay = '';
  const first = Math.ceil(props.startTime / step) * step;
  for (let ts = first; ts <= props.endTime; ts += step) {
    const d = new Date(ts);
    const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const date = `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const showDate = dayStep || dayKey !== prevDay;
    prevDay = dayKey;
    out.push({ pct: clampPct(ts), time: dayStep ? '' : `${p(d.getHours())}:${p(d.getMinutes())}`, date: showDate ? date : '' });
  }
  return out;
});

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function barTitle(bar: GanttBar, service: string): string {
  const e = bar.event;
  const who = e.source.serviceInstance || service;
  const when = bar.end ? `${fmtTime(bar.start)} → ${fmtTime(bar.end)}` : fmtTime(eventTs(e));
  return `${e.name} · ${e.type}\n${who}\n${when}${e.message ? '\n' + e.message : ''}`;
}

// Open scrolled to the newest events (right edge) on a range that overflows.
const scrollEl = ref<HTMLElement | null>(null);
function scrollToNewest(): void {
  const el = scrollEl.value;
  if (el && el.scrollWidth > el.clientWidth) el.scrollLeft = el.scrollWidth;
}
watch(
  () => [props.startTime, props.endTime, props.events],
  () => void nextTick(scrollToNewest),
  { immediate: true },
);
</script>

<template>
  <div class="gantt">
    <div v-if="isEmpty" class="gantt-empty">{{ t('No events in the current window.') }}</div>
    <div v-else ref="scrollEl" class="gantt-scroll">
      <div class="gantt-canvas" :style="{ '--time-min': timeMinPx + 'px' }">
        <!-- Full-height vertical gridlines behind the lanes. -->
        <div class="gantt-grid">
          <div v-for="(tk, i) in ticks" :key="i" class="gantt-gline" :style="{ left: tk.pct + '%' }" />
        </div>

        <!-- Sticky time-axis header. -->
        <div class="gantt-headrow">
          <div class="gantt-corner" />
          <div class="gantt-axis">
            <div v-for="(tk, i) in ticks" :key="i" class="gantt-tick" :style="{ left: tk.pct + '%' }">
              <span v-if="tk.date" class="gantt-tick-date">{{ tk.date }}</span>
              <span v-if="tk.time" class="gantt-tick-time">{{ tk.time }}</span>
            </div>
          </div>
        </div>

        <template v-for="r in rows" :key="r.key">
          <!-- Layer header -->
          <div v-if="r.kind === 'layer'" class="gantt-lhead" @click="toggle(r.collapseKey!)">
            <div class="gantt-lhead-label">
              <span class="gantt-caret" :class="{ collapsed: r.collapsed }">▾</span>
              <span class="gantt-lhead-name">{{ r.label }}</span>
              <span class="gantt-lhead-count mono">{{ r.count }}</span>
            </div>
            <div class="gantt-band" />
          </div>

          <!-- Service header (instanced service) -->
          <div v-else-if="r.kind === 'service'" class="gantt-shead" @click="toggle(r.collapseKey!)">
            <div class="gantt-shead-label" :style="{ paddingLeft: r.indent + 'px' }">
              <span class="gantt-caret" :class="{ collapsed: r.collapsed }">▾</span>
              <span class="gantt-dot" :style="{ background: r.color }" />
              <code class="gantt-shead-name">{{ r.label }}</code>
              <span class="gantt-shead-count mono">{{ r.count }}</span>
            </div>
            <div class="gantt-band gantt-band--svc" />
          </div>

          <!-- Lane row -->
          <div v-else class="gantt-row">
            <div class="gantt-row-label" :style="{ paddingLeft: r.indent + 'px' }">
              <span v-if="r.dot" class="gantt-dot" :style="{ background: r.color }" />
              <code class="gantt-row-label-text">{{ r.label }}</code>
            </div>
            <div class="gantt-row-lane" :style="{ height: rowH(r.subLanes!) + 'px' }">
              <template v-for="(bar, bi) in r.bars" :key="bi">
                <div
                  v-if="bar.end !== null"
                  class="gantt-bar"
                  :class="{ 'is-error': bar.event.type === 'Error', 'is-selected': bar.event.uuid === selectedUuid }"
                  :style="{ left: clampPct(bar.start) + '%', width: widthPct(bar) + '%', top: bar.subLane * BAR_H + 2 + 'px', background: r.color }"
                  :title="barTitle(bar, r.label)"
                  @click="emit('select-event', bar.event)"
                >
                  <span class="gantt-bar-label">{{ bar.event.name }}</span>
                </div>
                <div
                  v-else
                  class="gantt-mark"
                  :class="{ 'is-error': bar.event.type === 'Error', 'is-selected': bar.event.uuid === selectedUuid }"
                  :style="{ left: clampPct(bar.start) + '%', top: bar.subLane * BAR_H + BAR_H / 2 + 'px', background: r.color }"
                  :title="barTitle(bar, r.label)"
                  @click="emit('select-event', bar.event)"
                />
              </template>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gantt {
  --label-w: 240px;
  --head-h: 34px;
  --tick-color: rgba(255, 255, 255, 0.05);
  background: var(--sw-bg-1);
  border: 1px solid var(--sw-line);
  border-radius: 8px;
  overflow: hidden;
}
.gantt-empty { padding: 28px; text-align: center; font-size: 12px; color: var(--sw-fg-3); }
/* The only scroll surface (both axes). max-height reserves the modal chrome
   (header + bar + optional range editor) so many rows scroll HERE, not in a
   nested modal-body scrollbar; min() lets the 240px floor yield on very short
   viewports so it never exceeds the ceiling. */
.gantt-scroll { overflow: auto; min-height: min(240px, calc(100vh - 260px)); max-height: calc(100vh - 260px); }
.gantt-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.gantt-scroll::-webkit-scrollbar-thumb { background: var(--sw-line-2); border-radius: 4px; }
.gantt-scroll::-webkit-scrollbar-track { background: transparent; }
.gantt-canvas { position: relative; width: max(100%, calc(var(--label-w) + var(--time-min))); }

.gantt-grid { position: absolute; top: var(--head-h); left: var(--label-w); right: 0; bottom: 0; pointer-events: none; }
.gantt-gline { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--tick-color); transform: translateX(-50%); }

.gantt-headrow { display: flex; position: sticky; top: 0; z-index: 3; height: var(--head-h); }
.gantt-corner {
  width: var(--label-w); flex-shrink: 0;
  position: sticky; left: 0; z-index: 4;
  background: var(--sw-bg-1); border-right: 1px solid var(--sw-line); border-bottom: 1px solid var(--sw-line);
}
.gantt-axis { flex: 1 0 var(--time-min); position: relative; background: var(--sw-bg-1); border-bottom: 1px solid var(--sw-line); }
.gantt-tick { position: absolute; top: 0; bottom: 0; }
.gantt-tick-date { position: absolute; top: 3px; left: 0; transform: translateX(-50%); font-size: 9px; font-weight: 600; letter-spacing: 0.03em; color: var(--sw-fg-2); white-space: nowrap; font-variant-numeric: tabular-nums; }
.gantt-tick-time { position: absolute; top: 17px; left: 0; transform: translateX(-50%); font-size: 10px; color: var(--sw-fg-3); white-space: nowrap; font-variant-numeric: tabular-nums; }

.gantt-caret { font-size: 9px; color: var(--sw-fg-3); transition: transform 0.12s; flex-shrink: 0; }
.gantt-caret.collapsed { transform: rotate(-90deg); }
.gantt-dot { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }

.gantt-lhead, .gantt-shead, .gantt-row { display: flex; }
.gantt-lhead, .gantt-shead { cursor: pointer; }

.gantt-lhead-label {
  width: var(--label-w); flex-shrink: 0;
  position: sticky; left: 0; z-index: 2;
  display: flex; align-items: center; gap: 8px;
  height: 26px; padding: 0 10px;
  background: var(--sw-bg-2); border-right: 1px solid var(--sw-line); border-bottom: 1px solid var(--sw-line);
}
.gantt-lhead:hover .gantt-lhead-label { background: var(--sw-bg-3); }
.gantt-lhead-name { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--sw-fg-1); font-weight: 700; }
.gantt-lhead-count { margin-left: auto; font-size: 10.5px; color: var(--sw-fg-2); background: var(--sw-bg-1); padding: 0 6px; border-radius: 8px; }

.gantt-shead-label {
  width: var(--label-w); flex-shrink: 0;
  position: sticky; left: 0; z-index: 2;
  display: flex; align-items: center; gap: 7px;
  height: 24px; padding-right: 10px;
  background: var(--sw-bg-1); border-right: 1px solid var(--sw-line); border-bottom: 1px solid var(--sw-line);
}
.gantt-shead:hover .gantt-shead-label { background: var(--sw-bg-2); }
.gantt-shead-name { font-family: var(--sw-mono); font-size: 11.5px; color: var(--sw-fg-0); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gantt-shead-count { margin-left: auto; font-size: 10.5px; color: var(--sw-fg-2); background: var(--sw-bg-2); padding: 0 6px; border-radius: 8px; }

.gantt-band { flex: 1 0 var(--time-min); height: 26px; background: var(--sw-bg-2); border-bottom: 1px solid var(--sw-line); }
.gantt-band--svc { height: 24px; background: var(--sw-bg-1); }

.gantt-row-label {
  width: var(--label-w); flex-shrink: 0;
  position: sticky; left: 0; z-index: 2;
  display: flex; align-items: center; gap: 7px;
  padding-right: 10px;
  background: var(--sw-bg-1); border-right: 1px solid var(--sw-line); border-bottom: 1px solid var(--sw-line);
}
.gantt-row-label-text { font-family: var(--sw-mono); font-size: 10.5px; color: var(--sw-fg-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gantt-row-lane { flex: 1 0 var(--time-min); position: relative; border-bottom: 1px solid var(--sw-line); }

.gantt-bar {
  position: absolute; height: 15px; min-width: 6px; border-radius: 3px;
  display: flex; align-items: center; padding: 0 4px; overflow: hidden; cursor: pointer;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.25);
}
.gantt-bar:hover { filter: brightness(1.15); }
.gantt-bar-label { font-size: 9.5px; font-weight: 600; color: #0a0d12; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gantt-bar.is-error { box-shadow: 0 0 0 1.5px var(--sw-err); }
.gantt-bar.is-selected { box-shadow: 0 0 0 2px var(--sw-fg-0); z-index: 2; }

.gantt-mark {
  position: absolute; width: 10px; height: 10px;
  transform: translate(-50%, -50%) rotate(45deg); border-radius: 2px; cursor: pointer;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.3);
}
.gantt-mark:hover { filter: brightness(1.15); }
.gantt-mark.is-error { box-shadow: 0 0 0 1.5px var(--sw-err); }
.gantt-mark.is-selected { box-shadow: 0 0 0 2px var(--sw-fg-0); z-index: 2; }
</style>
