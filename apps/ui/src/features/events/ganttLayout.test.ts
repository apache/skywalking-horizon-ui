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
import type { EventRow } from '@skywalking-horizon-ui/api-client';
import { buildGantt, eventTs } from './ganttLayout';

function ev(o: {
  uuid?: string;
  service?: string;
  instance?: string;
  name?: string;
  type?: 'Normal' | 'Error';
  start?: number;
  end?: number | null;
  layer?: string;
}): EventRow {
  return {
    uuid: o.uuid ?? 'u',
    source: { service: o.service ?? 'svc', serviceInstance: o.instance ?? '', endpoint: '' },
    name: o.name ?? 'Start',
    type: o.type ?? 'Normal',
    message: null,
    parameters: [],
    startTime: o.start ?? 0,
    endTime: o.end ?? null,
    layer: o.layer ?? 'GENERAL',
  };
}

describe('eventTs', () => {
  it('uses endTime when finished, else startTime', () => {
    expect(eventTs(ev({ start: 100, end: 250 }))).toBe(250);
    expect(eventTs(ev({ start: 100, end: null }))).toBe(100);
    expect(eventTs(ev({ start: 100, end: 0 }))).toBe(100);
  });
});

describe('buildGantt — Layer → Service → Instance tree', () => {
  it('returns an empty tree for no events', () => {
    expect(buildGantt([])).toEqual([]);
  });

  it('collapses a service-scoped service (empty instance) to one row', () => {
    const t = buildGantt([
      ev({ service: 'a::b', instance: '', start: 100, end: 108 }),
      ev({ service: 'a::b', instance: '', start: 3_600_000 }),
    ]);
    expect(t).toHaveLength(1);
    expect(t[0]!.layer).toBe('GENERAL');
    expect(t[0]!.eventCount).toBe(2);
    const svc = t[0]!.services[0]!;
    expect(svc.service).toBe('a::b');
    expect(svc.serviceScoped).toBe(true);
    expect(svc.rows).toHaveLength(1);
    expect(svc.rows[0]!.instance).toBe('');
  });

  it('gives an instanced service one row per instance, sorted by name', () => {
    const t = buildGantt([
      ev({ service: 's', instance: 'i2', start: 100 }),
      ev({ service: 's', instance: 'i1', start: 200 }),
      ev({ service: 's', instance: 'i1', start: 300 }),
    ]);
    const svc = t[0]!.services[0]!;
    expect(svc.serviceScoped).toBe(false);
    expect(svc.rows.map((r) => r.instance)).toEqual(['i1', 'i2']);
    expect(svc.eventCount).toBe(3);
  });

  it('sorts layers then services by name and colors each service distinctly', () => {
    const t = buildGantt([
      ev({ layer: 'MESH', service: 'z' }),
      ev({ layer: 'GENERAL', service: 'b' }),
      ev({ layer: 'GENERAL', service: 'a' }),
    ]);
    expect(t.map((l) => l.layer)).toEqual(['GENERAL', 'MESH']);
    expect(t[0]!.services.map((s) => s.service)).toEqual(['a', 'b']);
    const colors = t.flatMap((l) => l.services.map((s) => s.color));
    expect(new Set(colors).size).toBe(colors.length);
  });

  it('stacks overlapping events on one instance into sub-lanes', () => {
    const overlap = buildGantt([
      ev({ service: 's', instance: 'i', start: 100, end: 200 }),
      ev({ service: 's', instance: 'i', start: 150, end: 250 }),
    ]);
    expect(overlap[0]!.services[0]!.rows[0]!.subLanes).toBe(2);

    const sequential = buildGantt([
      ev({ service: 's', instance: 'i', start: 100, end: 200 }),
      ev({ service: 's', instance: 'i', start: 300, end: 400 }),
    ]);
    expect(sequential[0]!.services[0]!.rows[0]!.subLanes).toBe(1);
  });

  it('renders an event with no end as an instant bar (end null)', () => {
    const t = buildGantt([ev({ service: 's', instance: 'i', start: 100, end: null })]);
    const bar = t[0]!.services[0]!.rows[0]!.bars[0]!;
    expect(bar.end).toBeNull();
    expect(bar.start).toBe(100);
  });
});
