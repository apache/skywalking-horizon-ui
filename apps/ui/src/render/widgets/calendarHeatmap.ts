/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * The pure half of `CalendarHeatmapWidget`: which resolution a window is
 * drawn at, bucketing a series into a grid (week × weekday at day
 * resolution, day × hour-of-day at hour resolution), the quantile intensity
 * steps, and the comparison ladder.
 *
 * Buckets are OAP-local wall-clock times carried as `yyyy-MM-dd` or
 * `yyyy-MM-dd HH`, the forms the landing response's `durationStart` takes at
 * DAY and HOUR step. All arithmetic runs on `Date.UTC`, so the browser's
 * timezone can never shift a cell to a neighbouring day or hour.
 */

import { CALENDAR_HEATMAP_HOURLY_MAX_DAYS, type CalendarHeatmapResolution } from '@skywalking-horizon-ui/api-client';

export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

/** How many shades a cell can take above "no data". */
export const INTENSITY_STEPS = 5;

/** The resolution a grid is actually drawn at; `auto` has been decided. */
export type Resolution = 'hour' | 'day';

/** `auto` draws a window OAP can serve at hour precision (14 days at most,
 *  the HOUR-step range limit) as days × 24 hours, since a day cell over ten
 *  days is ten squares, and anything longer as weeks × weekdays. An explicit
 *  `hour` past that limit falls back to `day` rather than to a read OAP
 *  refuses. */
export function resolutionFor(windowDays: number, requested: CalendarHeatmapResolution = 'auto'): Resolution {
  if (requested === 'day') return 'day';
  return windowDays <= CALENDAR_HEATMAP_HOURLY_MAX_DAYS ? 'hour' : 'day';
}

export interface CalendarHeatmapSeries {
  resolution: Resolution;
  /** The first bucket: `yyyy-MM-dd` at day resolution, `yyyy-MM-dd HH` at hour resolution. */
  start: string;
  /** One value per bucket from `start` on; `null` where OAP returned no bucket. */
  values: ReadonlyArray<number | null>;
}

export interface CalendarCell {
  /** The bucket, in the series' own form. */
  bucket: string;
  value: number | null;
  /** 0 = no data; 1..{@link INTENSITY_STEPS} by quantile within the window. */
  level: number;
  /** The last bucket of a window that ends now: the day or hour still in progress. */
  isCurrent: boolean;
}

/** What a row or column is labelled with; the widget formats it in the
 *  reader's locale. */
export type AxisLabel =
  | { kind: 'weekday'; weekday: number }
  | { kind: 'day'; day: string }
  | { kind: 'hour'; hour: number }
  | null;

export interface CalendarColumn {
  /** One per row; `null` where the column falls outside the window. */
  cells: ReadonlyArray<CalendarCell | null>;
  label: AxisLabel;
}

export interface CalendarGrid {
  resolution: Resolution;
  columns: CalendarColumn[];
  /** One per row: the first day the week draws at day resolution, the day at hour resolution. */
  rowLabels: AxisLabel[];
  thresholds: number[];
  /** Sum of the buckets that have a value; `null` when none has. */
  total: number | null;
  /** Mean of the buckets that have a value; `null` when none has. */
  average: number | null;
}

/** `yyyy-MM-dd` → UTC midnight in epoch ms, or `null` when it is not a day. */
export function parseDay(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) ? ms : null;
}

/** `yyyy-MM-dd HH` → that UTC hour in epoch ms, or `null`. */
export function parseHour(hour: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2})/.exec(hour);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]));
  return Number.isFinite(ms) ? ms : null;
}

const pad = (n: number): string => String(n).padStart(2, '0');

export function formatDay(utcMs: number): string {
  const d = new Date(utcMs);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function formatHour(utcMs: number): string {
  return `${formatDay(utcMs)} ${pad(new Date(utcMs).getUTCHours())}`;
}

/** Index of the day in a Monday-first week: Monday 0 … Sunday 6. */
export function weekdayIndex(utcMs: number): number {
  return (new Date(utcMs).getUTCDay() + 6) % 7;
}

/**
 * Nearest-rank quantiles of the positive values, `steps - 1` of them. A window
 * with one heavy bucket therefore does not flatten the rest: each shade covers
 * an equal share of the buckets that saw traffic, not an equal share of the
 * range.
 */
export function quantileThresholds(values: ReadonlyArray<number | null>, steps = INTENSITY_STEPS): number[] {
  const sorted = values
    .filter((v): v is number => v !== null && Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const out: number[] = [];
  for (let k = 1; k < steps; k++) {
    const idx = Math.ceil((k / steps) * sorted.length) - 1;
    out.push(sorted[Math.min(sorted.length - 1, Math.max(0, idx))]!);
  }
  return out;
}

/** `>=` on purpose: the window's maximum always takes the top shade, so a
 *  window with a single busy bucket draws it bold rather than faint. */
export function intensityLevel(value: number | null | undefined, thresholds: readonly number[]): number {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  let level = 1;
  for (const t of thresholds) if (value >= t) level++;
  return Math.min(INTENSITY_STEPS, level);
}

/** Hour labels every this many columns: 00, 06, 12, 18. */
const HOUR_LABEL_EVERY = 6;

export function buildCalendarGrid(series: CalendarHeatmapSeries): CalendarGrid | null {
  return series.resolution === 'hour' ? buildHourGrid(series) : buildDayGrid(series);
}

function totals(values: ReadonlyArray<number | null>): Pick<CalendarGrid, 'total' | 'average'> {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const total = present.length > 0 ? present.reduce((a, b) => a + b, 0) : null;
  return { total, average: total === null ? null : total / present.length };
}

/** Weeks as rows, Monday to Sunday as the seven columns. A window rarely
 *  starts on a Monday or ends on a Sunday, so the first and last rows are
 *  partial and the cells outside the window are blank. Each row is labelled
 *  with the first day it draws. */
function buildDayGrid(series: CalendarHeatmapSeries): CalendarGrid | null {
  const start = parseDay(series.start);
  if (start === null) return null;
  const n = series.values.length;
  const thresholds = quantileThresholds(series.values);
  const offset = weekdayIndex(start);
  const rowCount = n === 0 ? 0 : Math.ceil((offset + n) / 7);

  const columns: CalendarColumn[] = [];
  const rowLabels: AxisLabel[] = Array.from({ length: rowCount }, () => null);
  for (let c = 0; c < 7; c++) {
    const cells: Array<CalendarCell | null> = [];
    for (let r = 0; r < rowCount; r++) {
      const i = r * 7 + c - offset;
      if (i < 0 || i >= n) {
        cells.push(null);
        continue;
      }
      const day = formatDay(start + i * DAY_MS);
      if (rowLabels[r] === null) rowLabels[r] = { kind: 'day', day };
      const value = series.values[i] ?? null;
      cells.push({ bucket: day, value, level: intensityLevel(value, thresholds), isCurrent: i === n - 1 });
    }
    columns.push({ cells, label: { kind: 'weekday', weekday: c } });
  }

  return { resolution: 'day', columns, rowLabels, thresholds, ...totals(series.values) };
}

/** Days as rows, the 24 hours of the day as columns. A rolling window of
 *  `n` hours starts and ends mid-day, so the first and last rows are partial
 *  and the cells outside the window are blank. */
function buildHourGrid(series: CalendarHeatmapSeries): CalendarGrid | null {
  const start = parseHour(series.start);
  if (start === null) return null;
  const n = series.values.length;
  const thresholds = quantileThresholds(series.values);
  const firstHour = new Date(start).getUTCHours();
  const dayZero = start - firstHour * HOUR_MS;
  const rowCount = n === 0 ? 0 : Math.ceil((firstHour + n) / 24);

  const columns: CalendarColumn[] = [];
  for (let h = 0; h < 24; h++) {
    const cells: Array<CalendarCell | null> = [];
    for (let r = 0; r < rowCount; r++) {
      const i = r * 24 + h - firstHour;
      if (i < 0 || i >= n) {
        cells.push(null);
        continue;
      }
      const value = series.values[i] ?? null;
      cells.push({
        bucket: formatHour(start + i * HOUR_MS),
        value,
        level: intensityLevel(value, thresholds),
        isCurrent: i === n - 1,
      });
    }
    columns.push({ cells, label: h % HOUR_LABEL_EVERY === 0 ? { kind: 'hour', hour: h } : null });
  }

  return {
    resolution: 'hour',
    columns,
    rowLabels: Array.from({ length: rowCount }, (_, r) => ({ kind: 'day', day: formatDay(dayZero + r * DAY_MS) }) as AxisLabel),
    thresholds,
    ...totals(series.values),
  };
}

export interface ReferenceWork {
  /** A proper noun: never translated. */
  title: string;
  /** Approximate token count — the published word count × 1.3. */
  tokens: number;
}

/** Public-domain works, ascending. */
export const REFERENCE_WORKS: readonly ReferenceWork[] = [
  { title: 'Animal Farm', tokens: 40_000 },
  { title: 'The Great Gatsby', tokens: 63_000 },
  { title: 'Moby-Dick', tokens: 275_000 },
  { title: 'War and Peace', tokens: 780_000 },
];

export type WorkComparison =
  | { kind: 'times'; times: number; title: string }
  | { kind: 'percent'; percent: number; title: string };

/**
 * The largest reference at or below `total`, so the multiplier reads ≥ 1; a
 * total below the smallest reference is expressed as a share of that one.
 */
export function compareToWorks(total: number): WorkComparison | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  const smallest = REFERENCE_WORKS[0]!;
  if (total < smallest.tokens) {
    return { kind: 'percent', percent: (total / smallest.tokens) * 100, title: smallest.title };
  }
  let pick = smallest;
  for (const w of REFERENCE_WORKS) if (w.tokens <= total) pick = w;
  return { kind: 'times', times: total / pick.tokens, title: pick.title };
}

/** The grid with its axes swapped: the rows become the columns and the
 *  columns the rows, labels included. */
export function transposeGrid(g: CalendarGrid): CalendarGrid {
  const columns: CalendarColumn[] = g.rowLabels.map((label, r) => ({
    cells: g.columns.map((c) => c.cells[r] ?? null),
    label,
  }));
  return { ...g, columns, rowLabels: g.columns.map((c) => c.label) };
}

export interface FitBox {
  width: number;
  height: number;
  /** The row-label gutter, for the natural orientation and for the turned one. */
  labelW: number;
  labelWTurned: number;
  topH: number;
  gap: number;
}

export interface GridFit {
  /** The grid is drawn with its axes swapped. */
  turned: boolean;
  cellW: number;
  cellH: number;
}

/** A cell may be this many times wider than tall, or taller than wide. */
export const MAX_CELL_ASPECT = 2.5;
export const MIN_CELL = 4;
/** The turned orientation wins only when its cells come out this much
 *  larger, so a card that could go either way keeps the natural one. */
const TURN_GAIN = 1.15;

function cellsFor(cols: number, rows: number, width: number, height: number, box: FitBox): { cellW: number; cellH: number } {
  const w = (width - cols * box.gap) / Math.max(1, cols);
  const h = (height - box.topH - rows * box.gap) / Math.max(1, rows);
  return {
    cellW: Math.max(MIN_CELL, Math.min(w, h * MAX_CELL_ASPECT)),
    cellH: Math.max(MIN_CELL, Math.min(h, w * MAX_CELL_ASPECT)),
  };
}

/** The largest cells the card allows, in whichever orientation allows the
 *  larger: a wide card keeps the long axis across, a tall one turns it down.
 *  Cells fill the width and the height independently, up to
 *  {@link MAX_CELL_ASPECT}, so a wide card stretches them rather than
 *  leaving a margin. */
export function fitGrid(cols: number, rows: number, box: FitBox): GridFit {
  const natural = cellsFor(cols, rows, box.width - box.labelW, box.height, box);
  const turned = cellsFor(rows, cols, box.width - box.labelWTurned, box.height, box);
  const gain = Math.min(turned.cellW, turned.cellH) / Math.min(natural.cellW, natural.cellH);
  return gain > TURN_GAIN ? { turned: true, ...turned } : { turned: false, ...natural };
}

