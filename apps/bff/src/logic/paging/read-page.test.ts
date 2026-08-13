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
import {
  overFetchSize,
  probePaging,
  readPageWith,
  takeOverFetched,
  type OapPaging,
} from './read-page.js';

/** OAP's `PaginationUtils.exchange`, verbatim. */
function oapSlice(universe: readonly number[], p: OapPaging): number[] {
  return universe.slice(p.pageSize * (p.pageNum - 1), p.pageSize * (p.pageNum - 1) + p.pageSize);
}

function universe(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

describe('takeOverFetched', () => {
  it('keeps the extra row OUT of the page and reports it as the next page', () => {
    expect(takeOverFetched([1, 2, 3, 4, 5], 4)).toEqual({ rows: [1, 2, 3, 4], hasNext: true });
  });

  it('calls an exactly-full fetch complete — the case the old heuristic got wrong', () => {
    expect(takeOverFetched([1, 2, 3, 4], 4)).toEqual({ rows: [1, 2, 3, 4], hasNext: false });
  });

  it('calls a short fetch complete', () => {
    expect(takeOverFetched([1, 2], 4)).toEqual({ rows: [1, 2], hasNext: false });
  });

  it('calls an empty fetch complete', () => {
    expect(takeOverFetched([], 4)).toEqual({ rows: [], hasNext: false });
  });
});

describe('probePaging lands on the first row of the next page', () => {
  // `from = pageSize * (pageNum - 1)`, so a pageSize of 1 makes `from` the
  // page number minus one — the probe is an offset expressed as a page.
  it.each([
    { pageNum: 2, pageSize: 4, offset: 8 },
    { pageNum: 5, pageSize: 20, offset: 100 },
    { pageNum: 3, pageSize: 1, offset: 3 },
  ])('page $pageNum of size $pageSize probes offset $offset', ({ pageNum, pageSize, offset }) => {
    const probe = probePaging(pageNum, pageSize);
    expect(probe.pageSize).toBe(1);
    expect(probe.pageSize * (probe.pageNum - 1)).toBe(offset);
  });

  it('is the offset a plain over-fetch would MISS from page 2 on', () => {
    // Asking `{ pageNum: 2, pageSize: 5 }` for a display size of 4 reads offset
    // 5, skipping row 4 — which is why page N cannot over-fetch.
    const naive = { pageNum: 2, pageSize: overFetchSize(4) };
    expect(naive.pageSize * (naive.pageNum - 1)).toBe(5);
    expect(oapSlice(universe(9), naive)[0]).toBe(5);
    expect(oapSlice(universe(9), { pageNum: 2, pageSize: 4 })[0]).toBe(4);
  });
});

describe('readPageWith over a backend that pages the way OAP does', () => {
  const reader = (rows: readonly number[], calls: OapPaging[]) => async (p: OapPaging) => {
    calls.push(p);
    return oapSlice(rows, p);
  };

  it('page 1 makes ONE call, over-fetched by one', async () => {
    const calls: OapPaging[] = [];
    const out = await readPageWith(reader(universe(9), calls), { pageNum: 1, pageSize: 4 });
    expect(calls).toEqual([{ pageNum: 1, pageSize: 5 }]);
    expect(out).toEqual({ rows: [0, 1, 2, 3], pageNum: 1, pageSize: 4, hasNext: true });
  });

  it('a full FINAL page reports no next page', async () => {
    const out = await readPageWith(reader(universe(8), []), { pageNum: 2, pageSize: 4 });
    expect(out.rows).toEqual([4, 5, 6, 7]);
    expect(out.hasNext).toBe(false);
  });

  it('a partial page reports no next page', async () => {
    const out = await readPageWith(reader(universe(6), []), { pageNum: 2, pageSize: 4 });
    expect(out.rows).toEqual([4, 5]);
    expect(out.hasNext).toBe(false);
  });

  it('a page with a row behind it reports a next page', async () => {
    const out = await readPageWith(reader(universe(9), []), { pageNum: 2, pageSize: 4 });
    expect(out.rows).toEqual([4, 5, 6, 7]);
    expect(out.hasNext).toBe(true);
  });

  it('page N >= 2 keeps the page at its TRUE size, so no row is skipped', async () => {
    const calls: OapPaging[] = [];
    await readPageWith(reader(universe(9), calls), { pageNum: 2, pageSize: 4 });
    expect(calls).toContainEqual({ pageNum: 2, pageSize: 4 });
    expect(calls).toContainEqual({ pageNum: 9, pageSize: 1 });
  });

  it('walking a window to its end visits every row exactly once', async () => {
    const rows = universe(9);
    const seen: number[] = [];
    let pageNum = 1;
    for (;;) {
      const out = await readPageWith(reader(rows, []), { pageNum, pageSize: 4 });
      seen.push(...out.rows);
      if (!out.hasNext) break;
      pageNum += 1;
      expect(pageNum).toBeLessThan(10);
    }
    expect(seen).toEqual(rows);
  });

  it('repairs a nonsense page request instead of asking OAP for a negative offset', async () => {
    const calls: OapPaging[] = [];
    const out = await readPageWith(reader(universe(3), calls), { pageNum: 0, pageSize: 0 });
    expect(calls).toEqual([{ pageNum: 1, pageSize: 2 }]);
    expect(out.pageNum).toBe(1);
    expect(out.pageSize).toBe(1);
  });
});
