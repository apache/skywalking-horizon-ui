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
import { createFigureBuffer } from './figure-buffer.js';
import type { ChatFigure, PodLogSpec, SseEvent } from './types.js';

const podspec: PodLogSpec = {
  title: 'Pod logs — svc · app',
  container: 'app',
  initialLines: [],
  errorReason: null,
};

const fig = (id: string): ChatFigure => ({
  spec: { id, title: id, type: 'line', expressions: [] },
  result: { id },
});
type FigureEvent = Extract<SseEvent, { type: 'figure' }>;
function harness() {
  const events: FigureEvent[] = [];
  const buf = createFigureBuffer((ev) => {
    if (ev.type === 'figure') events.push(ev);
  });
  return { ...buf, events };
}

describe('createFigureBuffer', () => {
  it('emits an ungrouped figure immediately as single', () => {
    const h = harness();
    h.emitFigure({ title: 'A', figures: [fig('a')] });
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ n: 1, layout: 'single', title: 'A' });
    expect(h.events[0].figures).toHaveLength(1);
  });

  it('numbers successive singles', () => {
    const h = harness();
    h.emitFigure({ figures: [fig('a')] });
    h.emitFigure({ figures: [fig('b')] });
    expect(h.events.map((e) => e.n)).toEqual([1, 2]);
  });

  it('clusters same-group figures into ONE tabbed block on flush', () => {
    const h = harness();
    h.emitFigure({ title: 'Breakdown', figures: [fig('a')], group: 'g' });
    h.emitFigure({ figures: [fig('b')], group: 'g' });
    h.emitFigure({ figures: [fig('c')], group: 'g' });
    expect(h.events).toHaveLength(0); // buffered until flush
    h.flushFigures();
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ n: 1, layout: 'tabs', title: 'Breakdown' });
    expect(h.events[0].figures.map((f) => f.spec.id)).toEqual(['a', 'b', 'c']);
  });

  it('a single grouped figure flushes as single (not tabs)', () => {
    const h = harness();
    h.emitFigure({ figures: [fig('a')], group: 'g' });
    h.flushFigures();
    expect(h.events[0]).toMatchObject({ layout: 'single' });
  });

  it('a different group flushes the prior group first', () => {
    const h = harness();
    h.emitFigure({ figures: [fig('a')], group: 'g1' });
    h.emitFigure({ figures: [fig('b')], group: 'g1' });
    h.emitFigure({ figures: [fig('c')], group: 'g2' }); // flushes g1
    expect(h.events).toHaveLength(1);
    expect(h.events[0].figures.map((f) => f.spec.id)).toEqual(['a', 'b']);
    h.flushFigures();
    expect(h.events).toHaveLength(2);
    expect(h.events[1].figures.map((f) => f.spec.id)).toEqual(['c']);
  });

  it('an ungrouped figure flushes a pending group first', () => {
    const h = harness();
    h.emitFigure({ figures: [fig('a')], group: 'g' });
    h.emitFigure({ figures: [fig('b')] }); // flushes g, then emits b
    expect(h.events.map((e) => e.figures.map((f) => f.spec.id))).toEqual([['a'], ['b']]);
  });

  it('flushFigures on an empty buffer is a no-op', () => {
    const h = harness();
    h.flushFigures();
    expect(h.events).toHaveLength(0);
  });

  it('emitPodLogs shares the figure number and flushes a pending group first', () => {
    const events: SseEvent[] = [];
    const buf = createFigureBuffer((ev) => events.push(ev));
    buf.emitFigure({ figures: [fig('a')], group: 'g' }); // buffered
    buf.emitPodLogs(podspec); // flushes g (n=1), then podlogs (n=2)
    expect(events.map((e) => e.type)).toEqual(['figure', 'podlogs']);
    expect(events[0]).toMatchObject({ type: 'figure', n: 1 });
    expect(events[1]).toMatchObject({ type: 'podlogs', n: 2 });
  });
});
