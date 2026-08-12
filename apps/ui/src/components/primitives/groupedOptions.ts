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
 * TypeaheadSelect's grouping algorithm, pulled out of the component so the
 * ordering it produces is unit-testable without mounting Vue.
 *
 * `i` on each row is the DISPLAY position (groups in first-seen order, each
 * group's own rows in their collected order) — NOT the row's index in the
 * input array. Grouping can interleave rows from different sections (e.g.
 * input [A1, B1, A2] renders as A1, A2, B1), so a row's input-array index and
 * its on-screen position are different numbers once that happens. Keyboard
 * navigation walks screen positions by ±1, so it must address `i`, never the
 * input index — using the input index makes ArrowDown/Up skip to a
 * non-adjacent row the moment a group is not already contiguous.
 */
export interface GroupableOption {
  group?: string;
}

export interface GroupedSection<T> {
  name: string;
  rows: Array<{ o: T; i: number }>;
}

export function buildGroupedRows<T extends GroupableOption>(options: readonly T[]): GroupedSection<T>[] {
  const out: GroupedSection<T>[] = [];
  const byName = new Map<string, GroupedSection<T>>();
  for (const o of options) {
    const name = o.group ?? '';
    let g = byName.get(name);
    if (!g) {
      g = { name, rows: [] };
      byName.set(name, g);
      out.push(g);
    }
    g.rows.push({ o, i: -1 });
  }
  let displayIndex = 0;
  for (const g of out) for (const row of g.rows) row.i = displayIndex++;
  return out;
}

/** The flat render order — same items as `options`, reordered to match what
 *  `buildGroupedRows` puts on screen. */
export function flattenGroupedRows<T>(groups: readonly GroupedSection<T>[]): T[] {
  return groups.flatMap((g) => g.rows.map((r) => r.o));
}

/** Where `ArrowDown` should land after a page expansion reveals more rows.
 *
 *  Grouping re-sorts the WHOLE visible set on every expansion, and a page can
 *  reveal more than one row belonging to a group that renders BEFORE the
 *  currently active row — each such insertion shifts the active row's display
 *  position by one. A bare `activeIdx + 1` only accounts for exactly one
 *  insertion; re-finding the SAME option by identity in the new order is
 *  correct regardless of how many rows moved ahead of it. */
export function reindexActiveAfterExpand<V>(newDisplayRows: readonly { value: V }[], activeValueBefore: V | undefined): number {
  const lastIdx = newDisplayRows.length - 1;
  if (activeValueBefore === undefined) return lastIdx;
  const idx = newDisplayRows.findIndex((o) => o.value === activeValueBefore);
  return idx >= 0 ? Math.min(idx + 1, lastIdx) : lastIdx;
}
