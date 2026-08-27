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
 * A column decides WHICH endpoints it shows from live data, and WHERE it puts
 * them from what it showed last.
 *
 * Both halves matter and they pull in opposite directions. Ranking rows by the
 * live metric meant the column re-sorted itself every refresh, so an operator
 * watching one endpoint had to find it again after every tick. Freezing the
 * whole column instead would hide an endpoint that had just become the busiest
 * thing on the screen — which is the one an operator most needs to see.
 */

import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import type { EndpointDependencyCall, EndpointDependencyNode } from '@/api/client';
import { useEndpointDependencyLayout } from './useEndpointDependencyLayout';

const node = (id: string, cpm: number): EndpointDependencyNode =>
  ({ id, name: id, serviceId: 's', serviceName: 'svc', type: null, isReal: true, cpm }) as
    unknown as EndpointDependencyNode;

/** Focus plus N callees, so every extra node lands in one column (L+1). */
function graph(nodes: Array<[string, number]>): {
  nodes: EndpointDependencyNode[];
  calls: EndpointDependencyCall[];
} {
  return {
    nodes: [node('focus', 100), ...nodes.map(([id, cpm]) => node(id, cpm))],
    calls: nodes.map(([id]) => ({ source: 'focus', target: id }) as EndpointDependencyCall),
  };
}

function layout(initial: Array<[string, number]>) {
  const g = graph(initial);
  const nodes = ref(g.nodes);
  const calls = ref(g.calls);
  const l = useEndpointDependencyLayout({
    nodes,
    calls,
    focusedId: ref('focus'),
    centerDef: ref(null),
    nodeVal: () => null,
    dragAnchors: ref(new Map()),
    t: (k) => k,
  });
  /** A refresh: the same graph comes back with different numbers on it. */
  const refresh = (next: Array<[string, number]>): void => {
    const g2 = graph(next);
    nodes.value = g2.nodes;
    calls.value = g2.calls;
  };
  const callees = (): string[] =>
    l.layerColumns.value.find((c) => c.index === 1)?.visible.map((n) => n.id) ?? [];
  return { callees, refresh };
}

describe('a refresh does not reshuffle the column', () => {
  it('keeps every row where it was when only the numbers moved', () => {
    const { callees, refresh } = layout([
      ['a', 90],
      ['b', 50],
      ['c', 10],
    ]);
    const before = callees();
    expect(before, 'nothing was laid out — the rest would prove nothing').toEqual(['a', 'b', 'c']);

    // The order the metric WOULD now imply is the exact reverse.
    refresh([
      ['a', 10],
      ['b', 50],
      ['c', 90],
    ]);

    expect(callees(), 'the column re-sorted itself under the operator').toEqual(before);
  });

  it('gives a newly arrived endpoint the next free row rather than the top', () => {
    const { callees, refresh } = layout([
      ['a', 90],
      ['b', 50],
    ]);
    // Read first: a row is only "already on screen" once it has been drawn,
    // and the column is a lazy computed.
    expect(callees()).toEqual(['a', 'b']);

    refresh([
      ['a', 90],
      ['b', 50],
      ['d', 1000],
    ]);

    expect(callees(), 'an arrival displaced the rows already on screen').toEqual(['a', 'b', 'd']);
  });

  it('closes the gap when an endpoint leaves, and holds the rest', () => {
    const { callees, refresh } = layout([
      ['a', 90],
      ['b', 50],
      ['c', 10],
    ]);
    expect(callees()).toEqual(['a', 'b', 'c']);

    refresh([
      ['a', 90],
      ['c', 10],
    ]);

    expect(callees()).toEqual(['a', 'c']);
  });
});

describe('selection stays live', () => {
  it('admits an endpoint that has become busy enough to make the cut', () => {
    // Nine callees for eight rows: the quietest is left out. Then it becomes
    // the busiest — and being new to the visible set, it takes the free row
    // rather than the top, which is the point of the split.
    const nine: Array<[string, number]> = Array.from({ length: 9 }, (_, i) => [
      `n${i}`,
      100 - i,
    ]);
    const { callees, refresh } = layout(nine);
    expect(callees(), 'the quietest should have been cut').not.toContain('n8');

    refresh(nine.map(([id]) => [id, id === 'n8' ? 10_000 : 1] as [string, number]));

    expect(callees(), 'a newly busiest endpoint stayed hidden').toContain('n8');
  });
});
