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
 * The time range is one of the three filters the audit page offers. The route
 * validated `from`/`to` and the store turned them into real predicates from
 * the start, while the page had no control that set them — so the documented
 * filter was unreachable from the product and every list read the whole
 * retention window. These pin the wiring shut.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

type Page = {
  rows: Array<Record<string, unknown>>; pageNum: number; pageSize: number;
  hasNext: boolean;
};
const list = vi.fn(async (_query: Record<string, unknown>): Promise<Page> => ({
  rows: [], pageNum: 1, pageSize: 50, hasNext: false,
}));
const stat = vi.fn(async (_window: number) => ({ columns: [] as unknown[], overBudget: 0, horizonNodes: 1 }));

vi.mock('@/api/client', () => ({
  bff: {
    adminAudit: {
      list: (q: Record<string, unknown>) => list(q),
      stat: (w: number) => stat(w),
      status: async () => ({
        horizonNode: 'node-1', enabled: true, configured: true, available: true,
        rowsThisHour: 0, overBudgetThisHour: 0,
      }),
    },
  },
}));

const { useAuditPage } = await import('./useAuditPage');
const { ALL_TIME, CUSTOM_RANGE_SENTINEL } = await import('./useAuditPage');

/** The last query the page actually sent. */
function sent(): Record<string, unknown> {
  const call = list.mock.calls.at(-1);
  if (!call) throw new Error('no query was sent');
  return call[0];
}

beforeEach(() => { list.mockClear(); });

describe('the audit time range', () => {
  it('defaults to the whole retention window and sends no bounds', async () => {
    const page = useAuditPage();
    expect(page.filters.value.windowMinutes).toBe(ALL_TIME);
    await page.applyFilters();
    expect(sent()).not.toHaveProperty('from');
    expect(sent()).not.toHaveProperty('to');
  });

  it('turns a rolling preset into both bounds', async () => {
    const page = useAuditPage();
    page.setWindowMinutes(60);
    await page.applyFilters();
    const q = sent();
    expect(typeof q.from).toBe('number');
    expect(typeof q.to).toBe('number');
    expect((q.to as number) - (q.from as number)).toBe(60 * 60_000);
  });

  /* An empty `datetime-local` paints the BROWSER's locale placeholder, which
   * reads as Chinese on an English page whenever the two locales differ. */
  it('seeds both ends when custom mode is entered, so neither field is ever empty', () => {
    const page = useAuditPage();
    page.setWindowMinutes(180);
    page.setWindowMinutes(CUSTOM_RANGE_SENTINEL);
    expect(page.filters.value.customStart).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(page.filters.value.customEnd).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    const span = new Date(page.filters.value.customEnd as string).getTime()
      - new Date(page.filters.value.customStart as string).getTime();
    // Seeded from the window that was showing, not an arbitrary default.
    expect(span).toBe(180 * 60_000);
  });

  it('sends the custom bounds the operator picked', async () => {
    const page = useAuditPage();
    page.setWindowMinutes(CUSTOM_RANGE_SENTINEL);
    page.filters.value.customStart = '2026-08-22T09:00';
    page.filters.value.customEnd = '2026-08-22T17:30';
    await page.applyFilters();
    expect(sent().from).toBe(new Date('2026-08-22T09:00').getTime());
    expect(sent().to).toBe(new Date('2026-08-22T17:30').getTime());
  });

  it('refuses an unreadable date instead of querying without it', async () => {
    const page = useAuditPage();
    page.setWindowMinutes(CUSTOM_RANGE_SENTINEL);
    page.filters.value.customStart = 'not-a-date';
    await page.applyFilters();
    expect(list).not.toHaveBeenCalled();
    expect(page.rangeError.value).toBe('Invalid date');
  });

  it('refuses an end at or before the start rather than returning a silent empty page', async () => {
    const page = useAuditPage();
    page.setWindowMinutes(CUSTOM_RANGE_SENTINEL);
    page.filters.value.customStart = '2026-08-22T17:00';
    page.filters.value.customEnd = '2026-08-22T17:00';
    await page.applyFilters();
    expect(list).not.toHaveBeenCalled();
    expect(page.rangeError.value).toBe('End must be after start');
  });

  it('leaving custom mode drops the custom ends', () => {
    const page = useAuditPage();
    page.setWindowMinutes(CUSTOM_RANGE_SENTINEL);
    expect(page.filters.value.customStart).not.toBeNull();
    page.setWindowMinutes(ALL_TIME);
    expect(page.filters.value.customStart).toBeNull();
    expect(page.filters.value.customEnd).toBeNull();
  });

  it('clears the range and its complaint together', async () => {
    const page = useAuditPage();
    page.setWindowMinutes(CUSTOM_RANGE_SENTINEL);
    page.filters.value.customStart = 'not-a-date';
    await page.applyFilters();
    expect(page.rangeError.value).not.toBeNull();
    await page.clearFilters();
    expect(page.rangeError.value).toBeNull();
    expect(page.filters.value.windowMinutes).toBe(ALL_TIME);
    expect(sent()).not.toHaveProperty('from');
  });

  it('keeps paging inside the applied range rather than dropping it on page 2', async () => {
    const page = useAuditPage();
    page.setWindowMinutes(CUSTOM_RANGE_SENTINEL);
    page.filters.value.customStart = '2026-08-22T09:00';
    page.filters.value.customEnd = '2026-08-22T17:30';
    await page.applyFilters();
    page.hasNext.value = true;
    await page.go(1);
    expect(sent().from).toBe(new Date('2026-08-22T09:00').getTime());
    expect(sent().pageNum).toBe(2);
  });
});

/**
 * Two controls an operator can click faster than the server answers.
 *
 * Nothing ordered the replies, so 2h-then-12h could leave 2h's late response
 * on screen under a 12h control, and filters A-then-B could show A's rows
 * beside B's pagination. Each request takes a generation and only the newest
 * may write.
 */
describe('a superseded response must not land', () => {
  /** Resolve in the caller's chosen order, regardless of call order. */
  function deferred<T>() {
    let settle!: (v: T) => void;
    const promise = new Promise<T>((r) => { settle = r; });
    return { promise, settle };
  }

  it('keeps the newest window when an older stat request answers last', async () => {
    const first = deferred<{ columns: unknown[]; overBudget: number; horizonNodes: number }>();
    const second = deferred<{ columns: unknown[]; overBudget: number; horizonNodes: number }>();
    stat.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const page = useAuditPage();
    const a = page.setWindow(2);
    const b = page.setWindow(12);
    // The NEWER request answers first, then the older one arrives late.
    second.settle({ columns: [{ hourBucket: 12 }], overBudget: 0, horizonNodes: 1 });
    first.settle({ columns: [{ hourBucket: 2 }], overBudget: 0, horizonNodes: 1 });
    await Promise.all([a, b]);

    expect(page.statWindow.value).toBe(12);
    expect(page.stat.value?.columns).toEqual([{ hourBucket: 12 }]);
    expect(page.loadingStat.value).toBe(false);
  });

  it('keeps the newest filters when an older list request answers last', async () => {
    const first = deferred<{ rows: Array<Record<string, unknown>>; pageNum: number; pageSize: number; hasNext: boolean }>();
    const second = deferred<{ rows: Array<Record<string, unknown>>; pageNum: number; pageSize: number; hasNext: boolean }>();
    list.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const page = useAuditPage();
    page.filters.value.username = 'alice';
    const a = page.applyFilters();
    page.filters.value.username = 'bob';
    const b = page.applyFilters();
    second.settle({ rows: [{ id: 'bob-row' }], pageNum: 1, pageSize: 50, hasNext: false });
    first.settle({ rows: [{ id: 'alice-row' }], pageNum: 1, pageSize: 50, hasNext: true });
    await Promise.all([a, b]);

    expect(page.rows.value).toEqual([{ id: 'bob-row' }]);
    // `hasNext` from the stale reply would page a predicate nobody is showing.
    expect(page.hasNext.value).toBe(false);
    expect(page.loadingList.value).toBe(false);
  });

});

/**
 * Paging must name a POSITION, not an offset.
 *
 * The table is appended to at exactly the end the page reads from, so rows
 * written between two page requests shift an offset and the reader sees a
 * record twice or never. The window has the same problem: a rolling preset
 * resolved per page moved under the reader.
 */
describe('paging asks for a page number', () => {
  // The page number IS the position — the store skips `pageSize * (pageNum-1)`
  // rows, which is the arrangement OAP uses for every list it serves. Nothing
  // is carried between requests, so a page can be asked for on its own.
  it('sends the page number and nothing else to resume from', async () => {
    const page = useAuditPage();
    list.mockResolvedValueOnce({ rows: [{ id: '9' }], pageNum: 1, pageSize: 50, hasNext: true });
    await page.applyFilters();
    expect(sent().pageNum).toBe(1);
    expect(sent()).not.toHaveProperty('cursor');

    list.mockResolvedValueOnce({ rows: [{ id: '4' }], pageNum: 2, pageSize: 50, hasNext: false });
    await page.go(1);
    expect(sent().pageNum).toBe(2);
    expect(sent()).not.toHaveProperty('cursor');
  });

  it('freezes the rolling window so page two asks about the same span', async () => {
    const page = useAuditPage();
    page.setWindowMinutes(60);
    list.mockResolvedValueOnce({ rows: [{ id: '9' }], pageNum: 1, pageSize: 50, hasNext: true });
    await page.applyFilters();
    const first = { from: sent().from, to: sent().to };

    await new Promise((r) => { setTimeout(r, 20); });
    list.mockResolvedValueOnce({
      rows: [], pageNum: 2, pageSize: 50, hasNext: false,
    });
    await page.go(1);
    // Identical bounds, not recomputed against a later clock.
    expect({ from: sent().from, to: sent().to }).toEqual(first);
  });

  it('starts over when the filters change', async () => {
    const page = useAuditPage();
    list.mockResolvedValueOnce({ rows: [{ id: '9' }], pageNum: 1, pageSize: 50, hasNext: true });
    await page.applyFilters();
    await page.go(1);
    expect(sent().pageNum).toBe(2);

    // A new predicate means page one — page two of the OLD query names a
    // different set of rows entirely.
    page.filters.value.username = 'alice';
    await page.applyFilters();
    expect(sent().pageNum).toBe(1);
  });
});
