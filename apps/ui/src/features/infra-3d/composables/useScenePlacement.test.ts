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
