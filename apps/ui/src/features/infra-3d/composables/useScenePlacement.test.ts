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

import { describe, expect, it } from 'vitest';
import { computePlacement } from './useScenePlacement';
import type { SceneGraph, SceneLayer } from './useMapTopology';

function layer(key: string, plane: string, n: number): SceneLayer {
  return {
    key,
    name: key,
    level: null,
    group: null,
    serviceCount: n,
    color: null,
    plane,
    nodes: Array.from({ length: n }, (_, i) => ({
      nodeId: `${key}:${i}`,
      layerKey: key,
      serviceId: `${key}-${i}`,
      name: `${key}-${i}`,
      shortName: `${key}-${i}`,
      normal: true,
    })),
    callEdges: [],
  } as unknown as SceneLayer;
}

function graph(layers: SceneLayer[]): SceneGraph {
  return { layers, nodesByKey: new Map(), hierarchyEdges: [], crossLayerEdges: [] } as unknown as SceneGraph;
}

describe('computePlacement bounds — what the camera frames', () => {
  it('frames only the tiers that hold a zone', () => {
    // One populated tier out of four: the bounds are that plane alone, so the
    // default camera looks at it instead of at a point between empty planes.
    const p = computePlacement(graph([layer('AI_AGENT', 'middleware', 3)]));
    const middleware = p.planes.find((pl) => pl.id === 'middleware')!;
    expect(p.bounds.minY).toBe(middleware.y);
    expect(p.bounds.maxY).toBe(middleware.y);
    expect(p.bounds.maxX - p.bounds.minX).toBe(middleware.width);
    expect(p.bounds.maxZ - p.bounds.minZ).toBe(middleware.depth);
  });

  it('spans the populated tiers when there are several, and every plane when none is', () => {
    const two = computePlacement(graph([layer('GENERAL', 'apps', 4), layer('MYSQL', 'infra', 1)]));
    const apps = two.planes.find((pl) => pl.id === 'apps')!;
    const infra = two.planes.find((pl) => pl.id === 'infra')!;
    expect(two.bounds.maxY).toBe(apps.y);
    expect(two.bounds.minY).toBe(infra.y);
    expect(two.bounds.maxX - two.bounds.minX).toBe(Math.max(apps.width, infra.width));
    const none = computePlacement(graph([]));
    expect(none.bounds.minY).toBe(Math.min(...none.planes.map((pl) => pl.y)));
    expect(none.bounds.maxY).toBe(Math.max(...none.planes.map((pl) => pl.y)));
  });
});

// A layer split by service group reaches the scene as one layer per group
// entry; a logic group naming the layer takes every one of them.
describe('computePlacement logic groups', () => {
  it('put every entry of a split member layer in the group\'s block', () => {
    const group = { id: 'apps', label: 'Apps', level: 'apps', color: '#fff', icon: 'sky', layers: ['GENERAL'] };
    const p = computePlacement(
      graph([layer('general/', 'apps', 1), layer('general/payments', 'apps', 2), layer('mesh', 'apps', 1)]),
      undefined,
      [group],
    );
    const block = p.zones.find((z) => z.group?.id === 'apps');
    expect(block?.group?.layerKeys.sort()).toEqual(['general/', 'general/payments']);
    // The layer outside the group keeps a zone of its own.
    expect(p.zones.some((z) => !z.group && z.layerKey === 'mesh')).toBe(true);
  });
});

describe('computePlacement with groups differing only in case', () => {
  it('keeps both entries, in the logic group and out of it', () => {
    const group = { id: 'apps', label: 'Apps', level: 'apps', color: '#fff', icon: 'sky', layers: ['GENERAL'] };
    const entries = [layer('general/payments', 'apps', 1), layer('general/Payments', 'apps', 1)];
    const grouped = computePlacement(graph(entries), undefined, [group]);
    expect(grouped.zones.find((z) => z.group?.id === 'apps')?.group?.layerKeys.sort()).toEqual(['general/Payments', 'general/payments']);
    const solo = computePlacement(graph(entries));
    expect(solo.zones.map((z) => z.layerKey).sort()).toEqual(['general/Payments', 'general/payments']);
  });
});
