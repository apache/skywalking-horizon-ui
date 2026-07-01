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
  clampPageSize,
  clampWindowMs,
  buildEventsCondition,
  mapAndSortEvents,
  type OapEventRow,
} from './events.js';

const DAY_MS = 24 * 60 * 60_000;
const WEEK_MS = 7 * DAY_MS;
const NOW = 1_782_800_000_000; // fixed epoch for deterministic window math
const WIN = { start: '2026-06-30 000000', end: '2026-06-30 120000' };

describe('clampPageSize', () => {
  it('falls back when unset / below 1 / non-finite', () => {
    expect(clampPageSize(undefined, 200, 500)).toBe(200);
    expect(clampPageSize(0, 200, 500)).toBe(200);
    expect(clampPageSize(-5, 200, 500)).toBe(200);
    expect(clampPageSize(Number.NaN, 200, 500)).toBe(200);
  });
  it('clamps to the max and rounds', () => {
    expect(clampPageSize(999, 200, 500)).toBe(500);
    expect(clampPageSize(42.6, 200, 500)).toBe(43);
    expect(clampPageSize(120, 200, 500)).toBe(120);
  });
});

describe('clampWindowMs', () => {
  it('defaults to a rolling 1-day window ending at now', () => {
    expect(clampWindowMs(undefined, undefined, NOW)).toEqual({ startMs: NOW - DAY_MS, endMs: NOW });
  });
  it('honours a rolling window in minutes, capped at 7 days', () => {
    expect(clampWindowMs(360, undefined, NOW)).toEqual({ startMs: NOW - 360 * 60_000, endMs: NOW });
    // 30 days requested → clamped to a week
    expect(clampWindowMs(30 * 24 * 60, undefined, NOW)).toEqual({ startMs: NOW - WEEK_MS, endMs: NOW });
  });
  it('keeps an explicit absolute range within the cap unchanged', () => {
    const explicit = { startMs: NOW - 2 * DAY_MS, endMs: NOW };
    expect(clampWindowMs(undefined, explicit, NOW)).toEqual(explicit);
  });
  it('clamps an over-wide absolute range to its NEWEST 7 days', () => {
    const explicit = { startMs: NOW - 60 * DAY_MS, endMs: NOW };
    expect(clampWindowMs(undefined, explicit, NOW)).toEqual({ startMs: NOW - WEEK_MS, endMs: NOW });
  });
  it('ignores an inverted explicit range and falls back to rolling', () => {
    const explicit = { startMs: NOW, endMs: NOW - DAY_MS };
    expect(clampWindowMs(undefined, explicit, NOW)).toEqual({ startMs: NOW - DAY_MS, endMs: NOW });
  });
});

describe('buildEventsCondition', () => {
  const paging = { pageNum: 1, pageSize: 200 };

  it('omits source / type / name / layer entirely when the scope is empty', () => {
    const c = buildEventsCondition({}, WIN, 'DES', paging, false);
    expect(c).not.toHaveProperty('source');
    expect(c).not.toHaveProperty('type');
    expect(c).not.toHaveProperty('name');
    expect(c).not.toHaveProperty('layer');
    expect(c.order).toBe('DES');
    expect(c.paging).toEqual(paging);
    expect(c.time).toEqual({ start: WIN.start, end: WIN.end, step: 'SECOND' });
  });

  it('includes only the source fields that are set', () => {
    const c = buildEventsCondition({ service: 'agent::songs' }, WIN, 'DES', paging, false);
    expect(c.source).toEqual({ service: 'agent::songs' });

    const c2 = buildEventsCondition(
      { layer: 'MESH', service: 'svc', serviceInstance: 'i-1', endpoint: '/x', type: 'Error', name: 'Start' },
      WIN,
      'ASC',
      paging,
      false,
    );
    expect(c2.layer).toBe('MESH');
    expect(c2.source).toEqual({ service: 'svc', serviceInstance: 'i-1', endpoint: '/x' });
    expect(c2.type).toBe('Error');
    expect(c2.name).toBe('Start');
    expect(c2.order).toBe('ASC');
  });

  it('adds coldStage to the time only when asked', () => {
    const hot = buildEventsCondition({}, WIN, 'DES', paging, false) as { time: Record<string, unknown> };
    expect(hot.time).not.toHaveProperty('coldStage');
    const cold = buildEventsCondition({}, WIN, 'DES', paging, true) as { time: Record<string, unknown> };
    expect(cold.time.coldStage).toBe(true);
  });
});

describe('mapAndSortEvents', () => {
  const row = (over: Partial<OapEventRow>): OapEventRow => ({
    uuid: 'u',
    source: { service: 'svc', serviceInstance: '', endpoint: '' },
    name: 'Start',
    type: 'Normal',
    startTime: 0,
    endTime: 0,
    layer: 'GENERAL',
    ...over,
  });

  it('maps endTime 0 to null, keeps a real end, and defaults nullable fields', () => {
    const [a, b] = mapAndSortEvents(
      [
        row({ uuid: 'a', startTime: 100, endTime: 0, message: null, parameters: null, source: null }),
        row({ uuid: 'b', startTime: 200, endTime: 250 }),
      ],
      'ASC',
    );
    expect(a!.endTime).toBeNull();
    expect(a!.message).toBeNull();
    expect(a!.parameters).toEqual([]);
    expect(a!.source).toEqual({ service: '', serviceInstance: '', endpoint: '' });
    expect(b!.endTime).toBe(250);
  });

  it('sorts DES newest-first and ASC oldest-first by the effective timestamp (endTime else startTime)', () => {
    const rows = [
      row({ uuid: 'old', startTime: 100, endTime: 0 }), // ts 100
      row({ uuid: 'new', startTime: 300, endTime: 350 }), // ts 350
      row({ uuid: 'mid', startTime: 200, endTime: 0 }), // ts 200
    ];
    expect(mapAndSortEvents(rows, 'DES').map((e) => e.uuid)).toEqual(['new', 'mid', 'old']);
    expect(mapAndSortEvents(rows, 'ASC').map((e) => e.uuid)).toEqual(['old', 'mid', 'new']);
  });
});
