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
import { readFilteredPage, readPrefixPage } from './read-page.js';

/** A backend holding `rows` in order, asked only for its first rows. */
function backend(rows: number[]) {
  const asked: number[] = [];
  const fetchFirst = async (n: number) => {
    asked.push(n);
    return rows.slice(0, n);
  };
  return { fetchFirst, asked };
}

const even = (n: number) => n % 2 === 0;
const upTo = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('a page cut from the backend\'s first rows', () => {
  it('reads one row past page 1 to tell whether another follows', async () => {
    const b = backend(upTo(10));
    const page = await readPrefixPage(b.fetchFirst, { pageNum: 1, pageSize: 4 });
    expect(page.rows).toEqual([0, 1, 2, 3]);
    expect(page.hasNext).toBe(true);
    expect(b.asked).toEqual([5]);
  });

  it('serves a later page from one read that starts at row 0', async () => {
    const b = backend(upTo(10));
    const page = await readPrefixPage(b.fetchFirst, { pageNum: 3, pageSize: 3 });
    expect(page.rows).toEqual([6, 7, 8]);
    expect(page.hasNext).toBe(true);
    expect(b.asked).toEqual([10]);
  });

  it('says there is no more on the last page', async () => {
    const b = backend(upTo(9));
    const page = await readPrefixPage(b.fetchFirst, { pageNum: 3, pageSize: 3 });
    expect(page.rows).toEqual([6, 7, 8]);
    expect(page.hasNext).toBe(false);
  });
});

describe('a page of the rows a BFF-side filter keeps', () => {
  it('widens its read past rows the filter empties', async () => {
    // 10 odd rows, then the even ones: the first read keeps nothing.
    const b = backend([...Array.from({ length: 10 }, (_, i) => i * 2 + 1), 100, 102, 104]);
    const page = await readFilteredPage(b.fetchFirst, even, { pageNum: 1, pageSize: 2 }, { first: 5, maxRows: 100 });
    expect(page.rows).toEqual([100, 102]);
    expect(page.hasNext).toBe(true);
    expect(b.asked).toEqual([5, 20]);
  });

  it('says there is no more when the backend ran out', async () => {
    const b = backend([1, 2, 3, 4]);
    const page = await readFilteredPage(b.fetchFirst, even, { pageNum: 1, pageSize: 5 }, { first: 3, maxRows: 100 });
    expect(page.rows).toEqual([2, 4]);
    expect(page.hasNext).toBe(false);
  });

  it('serves a later page from the kept rows', async () => {
    const b = backend(upTo(20));
    const page = await readFilteredPage(b.fetchFirst, even, { pageNum: 2, pageSize: 3 }, { first: 4, maxRows: 100 });
    expect(page.rows).toEqual([6, 8, 10]);
    expect(page.hasNext).toBe(true);
  });

  it('starts at the depth of the page asked for, so a page the rows fill is read once', async () => {
    const b = backend(upTo(100));
    const page = await readFilteredPage(b.fetchFirst, even, { pageNum: 2, pageSize: 10 }, { first: 5, maxRows: 100 });
    expect(page.rows).toEqual([20, 22, 24, 26, 28, 30, 32, 34, 36, 38]);
    expect(page.hasNext).toBe(true);
    expect(b.asked).toEqual([21, 84]);
    const all = backend(upTo(100));
    await readFilteredPage(all.fetchFirst, () => true, { pageNum: 3, pageSize: 10 }, { first: 5, maxRows: 100 });
    expect(all.asked).toEqual([31]);
  });

  it('never starts past its budget', async () => {
    const b = backend(upTo(100));
    await readFilteredPage(b.fetchFirst, () => true, { pageNum: 5, pageSize: 10 }, { first: 5, maxRows: 30 });
    expect(b.asked).toEqual([30]);
  });

  it('stops at its budget and says more may exist', async () => {
    const b = backend(Array.from({ length: 1000 }, (_, i) => i * 2 + 1));
    const page = await readFilteredPage(b.fetchFirst, even, { pageNum: 1, pageSize: 5 }, { first: 10, maxRows: 30 });
    expect(page.rows).toEqual([]);
    expect(page.hasNext).toBe(true);
    expect(b.asked).toEqual([10, 30]);
  });
});
