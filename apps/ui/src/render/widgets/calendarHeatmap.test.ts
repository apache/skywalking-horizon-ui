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

import { describe, it, expect } from 'vitest';
import {
  buildCalendarGrid,
  compareToWorks,
  intensityLevel,
  parseDay,
  parseHour,
  quantileThresholds,
  resolutionFor,
  weekdayIndex,
  fitGrid,
  MAX_CELL_ASPECT,
  MIN_CELL,
  transposeGrid,
} from './calendarHeatmap';

describe('parseDay / parseHour / weekdayIndex', () => {
  it('reads a yyyy-MM-dd day as UTC midnight and ignores a trailing time', () => {
    expect(parseDay('2026-08-11')).toBe(Date.UTC(2026, 7, 11));
    expect(parseDay('2026-08-11 0930')).toBe(Date.UTC(2026, 7, 11));
    expect(parseDay('not a day')).toBeNull();
  });

  it('reads a yyyy-MM-dd HH hour and refuses a bare day', () => {
    expect(parseHour('2026-08-11 09')).toBe(Date.UTC(2026, 7, 11, 9));
    expect(parseHour('2026-08-11')).toBeNull();
  });

  it('puts Monday in row 0 and Sunday in row 6', () => {
    expect(weekdayIndex(Date.UTC(2024, 0, 1))).toBe(0); // a Monday
    expect(weekdayIndex(Date.UTC(2024, 0, 7))).toBe(6); // the Sunday after it
  });
});

describe('resolutionFor', () => {
  it('draws up to fourteen days by the hour and anything longer by the day', () => {
    expect(resolutionFor(10)).toBe('hour');
    expect(resolutionFor(14)).toBe('hour');
    expect(resolutionFor(15)).toBe('day');
    expect(resolutionFor(30)).toBe('day');
  });

  it('honours an explicit day, and lets an explicit hour fall back past the HOUR-step limit', () => {
    expect(resolutionFor(10, 'day')).toBe('day');
    expect(resolutionFor(10, 'hour')).toBe('hour');
    expect(resolutionFor(30, 'hour')).toBe('day');
  });
});

describe('buildCalendarGrid at day resolution', () => {
  const days = (start: string, values: Array<number | null>) => buildCalendarGrid({ resolution: 'day', start, values });

  it('lays days out weeks-as-rows and seven weekday columns, padding the first and last week', () => {
    // 2026-08-11 is a Tuesday: the first row starts one column in.
    const grid = days('2026-08-11', Array.from({ length: 30 }, (_, i) => i + 1))!;
    expect(grid.resolution).toBe('day');
    expect(grid.columns).toHaveLength(7);
    expect(grid.columns.map((c) => c.label)).toEqual(Array.from({ length: 7 }, (_, weekday) => ({ kind: 'weekday', weekday })));
    // Offset 1 + 30 days = 31 slots → 5 rows.
    expect(grid.rowLabels).toHaveLength(5);
    expect(grid.columns[0]!.cells[0]).toBeNull();
    expect(grid.columns[1]!.cells[0]?.bucket).toBe('2026-08-11');
    expect(grid.columns[6]!.cells[0]?.bucket).toBe('2026-08-16');
    expect(grid.columns[0]!.cells[1]?.bucket).toBe('2026-08-17');
    // The last day lands in the fifth row's Wednesday column (2026-09-09); the rest is padding.
    expect(grid.columns[2]!.cells[4]?.bucket).toBe('2026-09-09');
    expect(grid.columns[3]!.cells[4]).toBeNull();
  });

  it('labels each row with the first day it draws', () => {
    const grid = days('2026-08-11', Array.from({ length: 30 }, () => 1))!;
    expect(grid.rowLabels).toEqual(
      ['2026-08-11', '2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07'].map((day) => ({ kind: 'day', day })),
    );
  });

  it('marks only the last bucket as the one in progress', () => {
    const grid = days('2026-09-07', [1, 2, 3])!;
    const cells = grid.columns.flatMap((c) => c.cells).filter((c) => c !== null);
    expect(cells.map((c) => c.isCurrent)).toEqual([false, false, true]);
  });

  it('keeps a null bucket as no data (level 0) and sums only the days that have a value', () => {
    const grid = days('2026-09-07', [10, null, 30])!;
    const cells = grid.columns.flatMap((c) => c.cells).filter((c) => c !== null);
    expect(cells[1]!.value).toBeNull();
    expect(cells[1]!.level).toBe(0);
    expect(grid.total).toBe(40);
    expect(grid.average).toBe(20);
  });

  it('answers null totals for a window with no data at all', () => {
    const grid = days('2026-09-07', [null, null])!;
    expect(grid.total).toBeNull();
    expect(grid.average).toBeNull();
    expect(grid.thresholds).toEqual([]);
  });

  it('refuses a start it cannot read', () => {
    expect(days('', [1])).toBeNull();
  });
});

describe('buildCalendarGrid at hour resolution', () => {
  const hours = (start: string, values: Array<number | null>) => buildCalendarGrid({ resolution: 'hour', start, values });

  it('lays hours out days-as-rows and 24 hour columns, blank outside a rolling window', () => {
    // 2 days × 24 h ending at 09:00 on the 11th: starts at 10:00 on the 9th, spans three calendar days.
    const grid = hours('2026-08-09 10', Array.from({ length: 48 }, (_, i) => i + 1))!;
    expect(grid.resolution).toBe('hour');
    expect(grid.columns).toHaveLength(24);
    expect(grid.rowLabels).toEqual([
      { kind: 'day', day: '2026-08-09' },
      { kind: 'day', day: '2026-08-10' },
      { kind: 'day', day: '2026-08-11' },
    ]);
    // Row 0 is blank before 10:00; 10:00 is the first bucket.
    expect(grid.columns[9]!.cells[0]).toBeNull();
    expect(grid.columns[10]!.cells[0]?.bucket).toBe('2026-08-09 10');
    expect(grid.columns[10]!.cells[0]?.value).toBe(1);
    // Midnight of the 10th is bucket 14.
    expect(grid.columns[0]!.cells[1]?.bucket).toBe('2026-08-10 00');
    expect(grid.columns[0]!.cells[1]?.value).toBe(15);
    // The last bucket, 09:00 on the 11th, is the hour in progress; 10:00 that day is outside the window.
    expect(grid.columns[9]!.cells[2]?.bucket).toBe('2026-08-11 09');
    expect(grid.columns[9]!.cells[2]?.isCurrent).toBe(true);
    expect(grid.columns[10]!.cells[2]).toBeNull();
  });

  it('labels every sixth hour column', () => {
    const grid = hours('2026-08-09 00', Array.from({ length: 24 }, () => 1))!;
    expect(grid.columns.map((c) => c.label).filter(Boolean)).toEqual([
      { kind: 'hour', hour: 0 },
      { kind: 'hour', hour: 6 },
      { kind: 'hour', hour: 12 },
      { kind: 'hour', hour: 18 },
    ]);
    expect(grid.rowLabels).toHaveLength(1);
  });

  it('refuses a start without an hour', () => {
    expect(hours('2026-08-09', [1])).toBeNull();
  });
});

describe('quantileThresholds / intensityLevel', () => {
  it('spreads the shades over the buckets that saw traffic, not over the range', () => {
    // One heavy bucket. Range-based steps would leave the other nine at the faintest shade.
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 1000];
    const t = quantileThresholds(values);
    expect(t).toEqual([2, 4, 6, 8]);
    expect(values.map((v) => intensityLevel(v, t))).toEqual([1, 2, 2, 3, 3, 4, 4, 5, 5, 5]);
  });

  it('gives a lone busy bucket the top shade rather than the faintest', () => {
    const t = quantileThresholds([null, 37_368, null]);
    expect(intensityLevel(37_368, t)).toBe(5);
  });

  it('treats zero and null as no data', () => {
    const t = quantileThresholds([0, null, 5]);
    expect(intensityLevel(0, t)).toBe(0);
    expect(intensityLevel(null, t)).toBe(0);
  });
});

describe('compareToWorks', () => {
  it('picks the largest work at or below the total so the multiplier reads ≥ 1', () => {
    expect(compareToWorks(74_200_000)).toEqual({ kind: 'times', times: 74_200_000 / 780_000, title: 'War and Peace' });
    expect(compareToWorks(100_000)).toEqual({ kind: 'times', times: 100_000 / 63_000, title: 'The Great Gatsby' });
    expect(compareToWorks(40_000)).toEqual({ kind: 'times', times: 1, title: 'Animal Farm' });
  });

  it('falls back to a share of the smallest work below it', () => {
    expect(compareToWorks(20_000)).toEqual({ kind: 'percent', percent: 50, title: 'Animal Farm' });
  });

  it('has nothing to say about an empty window', () => {
    expect(compareToWorks(0)).toBeNull();
    expect(compareToWorks(Number.NaN)).toBeNull();
  });
});

describe('transposeGrid', () => {
  it('swaps the axes, labels included', () => {
    const g = buildCalendarGrid({ resolution: 'day', start: '2026-08-11', values: Array.from({ length: 30 }, () => 1) })!;
    const t = transposeGrid(g);
    expect(t.columns).toHaveLength(5);
    expect(t.rowLabels).toHaveLength(7);
    expect(t.columns.map((c) => c.label)).toEqual(g.rowLabels);
    expect(t.rowLabels).toEqual(g.columns.map((c) => c.label));
    expect(t.columns[0]!.cells[1]?.bucket).toBe('2026-08-11');
    expect(t.columns[4]!.cells[2]?.bucket).toBe('2026-09-09');
    expect(t.total).toBe(g.total);
  });
});

describe('fitGrid', () => {
  const box = { labelW: 44, labelWTurned: 30, topH: 12, gap: 3 };

  it('keeps a wide card the natural way and stretches the cells to its width', () => {
    const fit = fitGrid(24, 11, { ...box, width: 1100, height: 288 });
    expect(fit.turned).toBe(false);
    expect(fit.cellW).toBeGreaterThan(fit.cellH);
    expect(fit.cellW).toBeLessThanOrEqual(fit.cellH * MAX_CELL_ASPECT);
  });

  it('turns a tall narrow card so the long axis runs down', () => {
    const fit = fitGrid(24, 11, { ...box, width: 320, height: 576 });
    expect(fit.turned).toBe(true);
    expect(Math.min(fit.cellW, fit.cellH)).toBeGreaterThan(15);
  });

  it('never shrinks a cell below the floor', () => {
    const fit = fitGrid(24, 11, { ...box, width: 60, height: 40 });
    expect(fit.cellW).toBe(MIN_CELL);
    expect(fit.cellH).toBe(MIN_CELL);
  });
});
