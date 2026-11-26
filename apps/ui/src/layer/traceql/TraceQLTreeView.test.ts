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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { TraceQLSpan } from '@skywalking-horizon-ui/api-client';
import { i18n } from '@/i18n';
import TraceQLTreeView from './TraceQLTreeView.vue';

function span(spanId: string, parentSpanId = ''): TraceQLSpan {
  return {
    spanId, parentSpanId, service: 'app', resourceAttributes: [], name: 'GET /reserve', kind: 'SPAN_KIND_SERVER',
    startUs: 1000, durationUs: 100, status: 'ok', attributes: [], events: [],
  };
}

/** The canvas the SVG is drawn in, as the browser lays it out. */
function drawnAt(width: number, height: number): void {
  vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue(
    { width, height, x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, toJSON: () => ({}) } as DOMRect,
  );
}

async function viewBox(spans: TraceQLSpan[]): Promise<number[]> {
  const view = mount(TraceQLTreeView, { props: { spans }, global: { plugins: [i18n] } });
  await flushPromises();
  const box = view.find('svg.tqt-svg').attributes('viewBox')!.split(' ').map(Number);
  view.unmount();
  return box;
}

describe('TraceQLTreeView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('draws a short trace at its own size, not scaled up to fill the canvas', async () => {
    drawnAt(1000, 500);
    expect(await viewBox([span('a')]), 'one unit a pixel').toEqual([0, 0, 1000, 500]);
  });

  it('still shrinks a trace too large for the canvas to fit it', async () => {
    drawnAt(100, 50);
    const [, , w, h] = await viewBox([span('a'), span('b', 'a'), span('c', 'a')]);
    expect(w, 'as wide as the tree').toBeGreaterThan(100);
    expect(h, 'as tall as the tree').toBeGreaterThan(50);
  });
});
