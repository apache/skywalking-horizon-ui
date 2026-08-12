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
import { buildGroupedRows, flattenGroupedRows, reindexActiveAfterExpand } from './groupedOptions';

const opt = (label: string, group?: string) => ({ label, group });

describe('buildGroupedRows', () => {
  it('keeps a single ungrouped list in input order, indexed 0..n-1', () => {
    const g = buildGroupedRows([opt('a'), opt('b'), opt('c')]);
    expect(g).toHaveLength(1);
    expect(g[0].rows.map((r) => [r.o.label, r.i])).toEqual([
      ['a', 0], ['b', 1], ['c', 2],
    ]);
  });

  it('sections contiguous groups without reordering their rows', () => {
    const g = buildGroupedRows([opt('a1', 'A'), opt('a2', 'A'), opt('b1', 'B')]);
    expect(g.map((s) => s.name)).toEqual(['A', 'B']);
    expect(flattenGroupedRows(g).map((o) => o.label)).toEqual(['a1', 'a2', 'b1']);
  });

  // The case the fix targets: groups are NOT contiguous in the input.
  it('reorders interleaved groups so each section stays together on screen', () => {
    const input = [opt('a1', 'A'), opt('b1', 'B'), opt('a2', 'A'), opt('b2', 'B')];
    const g = buildGroupedRows(input);
    expect(g.map((s) => s.name)).toEqual(['A', 'B']);
    // Visual order: a1, a2 (group A), then b1, b2 (group B) — NOT input order.
    expect(flattenGroupedRows(g).map((o) => o.label)).toEqual(['a1', 'a2', 'b1', 'b2']);
  });

  it('assigns `i` as the DISPLAY position, not the input-array position', () => {
    const input = [opt('a1', 'A'), opt('b1', 'B'), opt('a2', 'A'), opt('b2', 'B')];
    const g = buildGroupedRows(input);
    // a1 was input[0] and stays display position 0 — no signal either way.
    // a2 was input[2] but is the SECOND thing on screen (display position 1);
    // b1 was input[1] but is the THIRD thing on screen (display position 2).
    // A naive `i = input index` would swap these two.
    const byLabel = new Map(g.flatMap((s) => s.rows).map((r) => [r.o.label, r.i]));
    expect(byLabel.get('a2')).toBe(1);
    expect(byLabel.get('b1')).toBe(2);
  });

  it('every `i` is unique and forms a contiguous 0..n-1 range matching flattenGroupedRows', () => {
    const input = [opt('a1', 'A'), opt('b1', 'B'), opt('a2', 'A'), opt('c1', 'C'), opt('b2', 'B')];
    const g = buildGroupedRows(input);
    const flat = flattenGroupedRows(g);
    const rows = g.flatMap((s) => s.rows);
    expect(rows.map((r) => r.i).sort((a, b) => a - b)).toEqual(input.map((_, i) => i));
    for (const r of rows) expect(flat[r.i]).toBe(r.o);
  });

  it('treats options with no group as one implicit section', () => {
    const g = buildGroupedRows([opt('a'), opt('b', 'X'), opt('c')]);
    expect(g.map((s) => s.name)).toEqual(['', 'X']);
  });
});

describe('reindexActiveAfterExpand', () => {
  const rows = (values: string[]) => values.map((value) => ({ value }));

  it('advances by one when nothing shifted ahead of the active row', () => {
    const after = rows(['a', 'b', 'c']);
    expect(reindexActiveAfterExpand(after, 'a')).toBe(1);
  });

  it('clamps to the last row when the active option is not found', () => {
    expect(reindexActiveAfterExpand(rows(['a', 'b']), 'zzz')).toBe(1);
  });

  it('clamps to the last row when nothing was active before (fresh open)', () => {
    expect(reindexActiveAfterExpand(rows(['a', 'b']), undefined)).toBe(1);
  });

  it('clamps at the end of the list rather than overrunning it', () => {
    expect(reindexActiveAfterExpand(rows(['a']), 'a')).toBe(0);
  });

  // The exact regression: 60 options alternating group A/B, PAGE=50. Page 1
  // groups as [A0..A24 display 0-24][B0..B24 display 25-49], active = B24 at
  // display 49. Expanding to all 60 regroups as [A0..A29][B0..B29] — B24 is
  // now the same option but at display position 54, NOT 50 (a bare `+1` on
  // the old index 49 would land on B20 instead).
  it('re-finds the active option by identity after a page expansion reorders groups', () => {
    const before = [];
    for (let i = 0; i < 25; i++) before.push({ value: `A${i}` }, { value: `B${i}` });
    // grouped display order for page 1: A0..A24, then B0..B24
    const displayBefore = [...before.filter((o) => o.value.startsWith('A')), ...before.filter((o) => o.value.startsWith('B'))];
    expect(displayBefore[49].value).toBe('B24');

    const after = [];
    for (let i = 0; i < 30; i++) after.push({ value: `A${i}` }, { value: `B${i}` });
    const displayAfter = [...after.filter((o) => o.value.startsWith('A')), ...after.filter((o) => o.value.startsWith('B'))];
    // B24 is at display position 54 in the expanded, regrouped order.
    expect(displayAfter.findIndex((o) => o.value === 'B24')).toBe(54);

    // The fix lands one PAST the previously-active option (B24 -> B25), not
    // on B24 itself and not on the wrong row a bare `49 + 1 = 50` would hit.
    expect(reindexActiveAfterExpand(displayAfter, 'B24')).toBe(55);
    expect(displayAfter[55].value).toBe('B25');
  });
});
