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

import type { ProfileAnalyzationElement, ProfileAnalyzationTree } from '@/api/client';

/**
 * The analyze trees as the stack views draw them: OAP's flat element lists
 * turned into a forest, with the frames an operator chose to hide FOLDED into
 * one row per connected group rather than dropped. A folded row keeps the
 * numbers of what it stands for — the top frame's duration and dump count, and
 * the self time of every frame in it — because the frame where the time is
 * actually spent is often a JDK one (`Thread.sleep`, `socketRead0`), and
 * hiding it must not make that time disappear.
 */
export interface StackNode {
  /** Unique across all trees; a folded group is keyed by its top frame. */
  key: string;
  /** The key the row's top frame has unfolded — the row's own for a frame. */
  frameKey: string;
  /** null for a folded group. */
  codeSignature: string | null;
  duration: number;
  durationChildExcluded: number;
  count: number;
  /** The frames a folded group stands for, top first. Empty for a frame. */
  hidden: ProfileAnalyzationElement[];
  /** Set on the top frame of a group the operator unfolded, to fold it back. */
  unfoldedGroupKey: string | null;
  /** One of the ten largest self times — a group is when any frame in it is. */
  top: boolean;
  /** Matches the search text — a group does when any frame in it does. */
  match: boolean;
  children: StackNode[];
}

export interface FoldOptions {
  hidePatterns?: readonly string[];
  /** Group keys the operator unfolded. */
  unfolded?: ReadonlySet<string>;
  search?: string;
}

/**
 * One-click sets of hide patterns, grouped by the agent whose frames they
 * match. Each agent names a frame its own way, as OAP returns it:
 *   Java   `org.apache.tomcat.util.net.SocketProcessorBase.run:49`
 *   Python `<file path>.<function>: <line>` — the path differs per host, so
 *          its patterns match anywhere in the name
 *   Go     `<function>:<line>`, e.g. `net/http.(*conn).serve:2009`
 * The SkyWalking Java agent renames an enhanced method's body to
 * `…$sw$original$<method>…` and that frame carries the operator's own line
 * number, so only its interceptor, auxiliary and accessor frames are listed.
 */
export const FRAME_PRESETS = {
  jdk: ['java.', 'javax.', 'jdk.', 'sun.', 'com.sun.'],
  tomcat: ['org.apache.tomcat.', 'org.apache.catalina.', 'org.apache.coyote.'],
  jetty: ['org.eclipse.jetty.'],
  undertow: ['io.undertow.'],
  spring: ['org.springframework.'],
  netty: ['io.netty.'],
  grpcJava: ['io.grpc.'],
  skywalkingJava: ['org.apache.skywalking.apm.agent.', '*$sw$auxiliary$', '*$accessor$$sw$'],
  pythonLibraries: ['*/lib/python'],
  // `io.` and `net.` alone would also match Java's `io.netty.` or
  // `net.bytebuddy.`; only a Go method frame has `.(*` after its package.
  goStd: [
    'runtime.', 'internal/', 'sync.', 'syscall.', 'reflect.', 'context.', 'net.(*', 'net/',
    'io.(*', 'bufio.', 'os.', 'time.', 'crypto/', 'encoding/',
  ],
  skywalkingGo: ['github.com/apache/skywalking-go/'],
} as const satisfies Record<string, readonly string[]>;

/** A pattern as typed. It matches a frame whose name STARTS with it; `*`
 *  matches any text, so a trailing one changes nothing (`java.*` is `java.`)
 *  and a leading one lets it match anywhere, as the Python preset does. */
export function normalizeHidePattern(raw: string): string | null {
  const value = raw.trim().replace(/\*+$/, '');
  return value && !/\s/.test(value) && value.replace(/\*/g, '') ? value : null;
}

const matchers = new Map<string, RegExp>();
function matcher(pattern: string): RegExp {
  let re = matchers.get(pattern);
  if (!re) {
    const body = pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    re = new RegExp('^' + body);
    matchers.set(pattern, re);
  }
  return re;
}

export function isFrameHidden(signature: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matcher(p).test(signature));
}

/** Children by parent id, and the roots: the frames whose parent is not in the
 *  tree. OAP's Java/Python analyzer roots a tree at parent `0` with ids from 1;
 *  its Go analyzer roots it at parent `-1` with the root's own id `0`. */
export function indexTree(tree: ProfileAnalyzationTree): {
  kids: Map<string, ProfileAnalyzationElement[]>;
  roots: ProfileAnalyzationElement[];
  byId: Map<string, ProfileAnalyzationElement>;
} {
  const kids = new Map<string, ProfileAnalyzationElement[]>();
  const byId = new Map<string, ProfileAnalyzationElement>();
  for (const e of tree.elements) {
    byId.set(e.id, e);
    const list = kids.get(e.parentId);
    if (list) list.push(e);
    else kids.set(e.parentId, [e]);
  }
  const roots = tree.elements.filter((e) => !byId.has(e.parentId));
  return { kids, roots, byId };
}

/** Self values for a tree whose elements carry only inclusive totals — eBPF
 *  reports each frame's total dump count and no self — as the total minus
 *  the children's totals. Folding sums self values, so an inclusive one
 *  standing in for self would count the same samples once per frame. */
export function withSelfFromTotals(tree: ProfileAnalyzationTree): ProfileAnalyzationTree {
  const { kids } = indexTree(tree);
  return {
    elements: tree.elements.map((e) => {
      const children = (kids.get(e.id) ?? []).reduce((sum, c) => sum + c.duration, 0);
      return { ...e, durationChildExcluded: Math.max(0, e.duration - children) };
    }),
  };
}

function topSelfTimes(trees: readonly ProfileAnalyzationTree[]): Set<number> {
  const all = trees.flatMap((t) => t.elements.map((e) => e.durationChildExcluded));
  return new Set([...all].sort((a, b) => b - a).filter((v, i) => i < 10 && v !== 0));
}

export function foldStack(trees: readonly ProfileAnalyzationTree[], opts: FoldOptions = {}): StackNode[] {
  const patterns = opts.hidePatterns ?? [];
  const unfolded = opts.unfolded ?? new Set<string>();
  const needle = (opts.search ?? '').trim().toLowerCase();
  const tops = topSelfTimes(trees);
  const isTop = (e: ProfileAnalyzationElement) => tops.has(e.durationChildExcluded);
  const isMatch = (e: ProfileAnalyzationElement) => !!needle && e.codeSignature.toLowerCase().includes(needle);

  const forest: StackNode[] = [];
  trees.forEach((tree, ti) => {
    const { kids, roots, byId } = indexTree(tree);
    const hidden = (e: ProfileAnalyzationElement) => isFrameHidden(e.codeSignature, patterns);
    const groupKey = (top: ProfileAnalyzationElement) => `${ti}:${top.id}:hidden`;
    // The group a hidden frame belongs to is named by its topmost hidden
    // ancestor in an unbroken run of hidden frames.
    const groupTop = (e: ProfileAnalyzationElement): ProfileAnalyzationElement => {
      let cur = e;
      for (let p = byId.get(cur.parentId); p && hidden(p); p = byId.get(cur.parentId)) cur = p;
      return cur;
    };

    const frame = (e: ProfileAnalyzationElement, unfoldedGroupKey: string | null): StackNode => ({
      key: `${ti}:${e.id}`,
      frameKey: `${ti}:${e.id}`,
      codeSignature: e.codeSignature,
      duration: e.duration,
      durationChildExcluded: e.durationChildExcluded,
      count: e.count,
      hidden: [],
      unfoldedGroupKey,
      top: isTop(e),
      match: isMatch(e),
      children: (kids.get(e.id) ?? []).map(convert),
    });

    function convert(e: ProfileAnalyzationElement): StackNode {
      if (!hidden(e)) return frame(e, null);
      const top = groupTop(e);
      const key = groupKey(top);
      if (unfolded.has(key)) return frame(e, top === e ? key : null);
      // Pre-order, so the frames under the group keep the order they have
      // when nothing is folded.
      const members: ProfileAnalyzationElement[] = [];
      const outside: ProfileAnalyzationElement[] = [];
      const absorb = (m: ProfileAnalyzationElement) => {
        members.push(m);
        for (const c of kids.get(m.id) ?? []) {
          if (hidden(c)) absorb(c);
          else outside.push(c);
        }
      };
      absorb(e);
      return {
        key,
        frameKey: `${ti}:${e.id}`,
        codeSignature: null,
        duration: e.duration,
        durationChildExcluded: members.reduce((s, m) => s + m.durationChildExcluded, 0),
        count: e.count,
        hidden: members,
        unfoldedGroupKey: null,
        top: members.some(isTop),
        match: members.some(isMatch),
        children: outside.map(convert),
      };
    }

    for (const root of roots) forest.push(convert(root));
  });
  return forest;
}

/** How many frames the folded rows stand for, and how many rows match. */
export function stackStats(nodes: readonly StackNode[]): { hidden: number; matches: number } {
  let hidden = 0;
  let matches = 0;
  const walk = (list: readonly StackNode[]) => {
    for (const n of list) {
      hidden += n.hidden.length;
      if (n.match) matches += 1;
      walk(n.children);
    }
  };
  walk(nodes);
  return { hidden, matches };
}
