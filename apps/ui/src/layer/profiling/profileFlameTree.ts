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

import * as d3 from 'd3';
import type { ProfileAnalyzationElement, ProfileAnalyzationTree } from '@/api/client';
import { foldStack, indexTree, type StackNode } from './profileStackFold';

/** One d3-flame-graph cell. */
export interface FlameNode {
  name: string;
  value: number;
  count: number;
  duration: number;
  durationChildExcluded: number;
  codeSignature: string;
  originId: string;
  /** Signatures a folded cell stands for; empty for a frame. */
  hidden: string[];
  children?: FlameNode[];
}

export interface FlameOptions {
  metricKey: 'count' | 'duration';
  hidePatterns: readonly string[];
  hiddenLabel: (n: number) => string;
}

/**
 * The analyze trees as one d3-flame-graph root. A cell's width is the metric
 * mapped onto 1–200, raised to at least the sum of its children's — which
 * d3-flame-graph needs to lay frames out. Both steps run on the UNFOLDED
 * trees, and a folded cell takes its top frame's width: computing either
 * after folding would let hiding frames resize the frames still shown.
 */
export function buildFlameRoot(trees: readonly ProfileAnalyzationTree[], opts: FlameOptions): FlameNode | null {
  if (!trees.length) return null;
  const metricFor = (el: { count: number; duration: number }) =>
    Math.max(0, opts.metricKey === 'duration' ? el.duration : el.count);
  const all = trees.flatMap((t) => t.elements.map(metricFor));
  const min = all.length ? Math.min(...all) : 0;
  const max = all.length ? Math.max(...all) : 1;
  const scale = d3.scaleLinear().domain([min, max]).range([1, 200]);

  const widths = new Map<string, number>();
  trees.forEach((tree, ti) => {
    const { kids, roots } = indexTree(tree);
    const width = (e: ProfileAnalyzationElement): number => {
      const own = Number(scale(metricFor(e)).toFixed(4));
      const children = (kids.get(e.id) ?? []).reduce((s, c) => s + width(c), 0);
      const w = Math.max(own, children);
      widths.set(`${ti}:${e.id}`, w);
      return w;
    };
    for (const root of roots) width(root);
  });

  const toFlame = (n: StackNode): FlameNode => {
    const label = n.codeSignature ?? opts.hiddenLabel(n.hidden.length);
    return {
      name: label,
      value: widths.get(n.frameKey) ?? 0,
      count: n.count,
      duration: n.duration,
      durationChildExcluded: n.durationChildExcluded,
      codeSignature: label,
      originId: n.key,
      hidden: n.hidden.map((e) => e.codeSignature),
      children: n.children.length ? n.children.map(toFlame) : undefined,
    };
  };

  const root: FlameNode = {
    name: 'Virtual Root',
    value: 0,
    count: 0,
    duration: 0,
    durationChildExcluded: 0,
    codeSignature: 'Virtual Root',
    originId: 'virtual-root',
    hidden: [],
    children: foldStack(trees, { hidePatterns: opts.hidePatterns }).map(toFlame),
  };
  root.value = (root.children ?? []).reduce((s, c) => s + c.value, 0);
  return root;
}
