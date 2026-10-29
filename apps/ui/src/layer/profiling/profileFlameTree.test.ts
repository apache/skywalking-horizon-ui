// Licensed to the Apache Software Foundation (ASF) under one or more
// contributor license agreements.  See the NOTICE file distributed with
// this work for additional information regarding copyright ownership.
// The ASF licenses this file to You under the Apache License, Version 2.0
// (the "License"); you may not use this file except in compliance with
// the License.  You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { describe, it, expect } from 'vitest';
import type { ProfileAnalyzationTree } from '@/api/client';
import { buildFlameRoot, type FlameNode } from './profileFlameTree';

/** A 100-sample request: a 20-sample application branch beside an
 *  80-sample framework branch whose leaves hold 1 and 79 samples. */
const TREE: ProfileAnalyzationTree = {
  elements: [
    { id: '1', parentId: '0', codeSignature: 'com.example.Handler.run', duration: 0, durationChildExcluded: 0, count: 100 },
    { id: '2', parentId: '1', codeSignature: 'com.example.App.work', duration: 0, durationChildExcluded: 0, count: 20 },
    { id: '3', parentId: '1', codeSignature: 'org.framework.Dispatch.run', duration: 0, durationChildExcluded: 0, count: 80 },
    { id: '4', parentId: '3', codeSignature: 'org.framework.Small.run', duration: 0, durationChildExcluded: 0, count: 1 },
    { id: '5', parentId: '3', codeSignature: 'org.framework.Large.run', duration: 0, durationChildExcluded: 0, count: 79 },
  ],
};

const build = (hidePatterns: string[]) =>
  buildFlameRoot([TREE], { metricKey: 'count', hidePatterns, hiddenLabel: (n) => `⋯ ${n}` }) as FlameNode;

const byName = (root: FlameNode, name: string): FlameNode | undefined => {
  if (root.name === name) return root;
  for (const c of root.children ?? []) {
    const hit = byName(c, name);
    if (hit) return hit;
  }
  return undefined;
};

describe('buildFlameRoot', () => {
  it('hiding frames leaves the width of the frames still shown alone', () => {
    const shown = byName(build([]), 'com.example.App.work');
    const afterHiding = byName(build(['org.framework.']), 'com.example.App.work');
    expect(afterHiding?.value).toBe(shown?.value);
  });

  it('hiding a branch of many small frames leaves the shares of the others alone', () => {
    // Each 1-sample leaf maps to at least 1 of the 1–200 range, so 500 of them
    // widen their parent past its own metric; that must survive folding.
    const elements: ProfileAnalyzationTree['elements'] = [
      { id: '1', parentId: '0', codeSignature: 'com.example.Root.run', duration: 0, durationChildExcluded: 0, count: 1000 },
      { id: '2', parentId: '1', codeSignature: 'com.example.App.leaf', duration: 0, durationChildExcluded: 500, count: 500 },
      { id: '3', parentId: '1', codeSignature: 'org.framework.Branch.run', duration: 0, durationChildExcluded: 0, count: 500 },
    ];
    for (let i = 0; i < 500; i++) {
      elements.push({ id: String(10 + i), parentId: '3', codeSignature: `org.framework.Leaf${i}.run`, duration: 0, durationChildExcluded: 1, count: 1 });
    }
    const share = (hide: string[]) => {
      const root = buildFlameRoot([{ elements }], { metricKey: 'count', hidePatterns: hide, hiddenLabel: String }) as FlameNode;
      return (byName(root, 'com.example.App.leaf')?.value ?? 0) / root.value;
    };
    expect(share(['org.framework.'])).toBeCloseTo(share([]), 10);
  });

  it('draws a folded group as one cell with the frames it stands for', () => {
    const handler = byName(build(['org.framework.']), 'com.example.Handler.run');
    const group = handler?.children?.find((c) => c.hidden.length);
    expect(group?.name).toBe('⋯ 3');
    expect(group?.count).toBe(80);
    expect(group?.hidden).toEqual(['org.framework.Dispatch.run', 'org.framework.Small.run', 'org.framework.Large.run']);
  });

  it('draws every root a tree has', () => {
    const twoRoots: ProfileAnalyzationTree = {
      elements: [
        { id: '1', parentId: '0', codeSignature: 'a', duration: 0, durationChildExcluded: 0, count: 2 },
        { id: '2', parentId: '0', codeSignature: 'b', duration: 0, durationChildExcluded: 0, count: 3 },
      ],
    };
    const root = buildFlameRoot([twoRoots], { metricKey: 'count', hidePatterns: [], hiddenLabel: String });
    expect(root?.children?.map((c) => c.name)).toEqual(['a', 'b']);
  });
});
